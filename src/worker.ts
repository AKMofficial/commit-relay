import { formatProblems, logConfigLoaded, tryGetConfig, type ConfigResult } from './config/load.ts';
import { compileRoutes } from './config/routing.ts';
import type { EnvSource } from './config/env.ts';
import { type Deps, createDeps, withSubrequestBudget } from './runtime/deps.ts';
import type { Config } from './config/schema.ts';
import type { CompiledRouting, RelayJob, QueuedJob } from './core/types.ts';
import { isRouteMatch, toQueuedJob } from './core/types.ts';
import { app, setAppContext } from './http/app.ts';
import { setHealthDeps } from './http/health.ts';
import { webhookPathFromEnv, pathnameOf } from './http/webhook.ts';
import { createLogger, loggerFor } from './obs/log.ts';
import { createMetrics } from './obs/metrics.ts';
import { CfQueueTier } from './queue/adapters/cf-queue.ts';
import { WaitUntilTier } from './queue/adapters/cf-waituntil.ts';
import { consumeJob, type RelayOutcome } from './queue/consumer.ts';
import type { Dedup } from './relay/dedup.ts';
import { recordDeferredDrop } from './relay/drop.ts';
import { isDeferred } from './relay/poster.ts';
import { queuedJobSchema } from './queue/queued-job-schema.ts';
import { createMemoryDedup } from './queue/adapters/store-memory.ts';
import type { AsyncTier } from './queue/types.ts';

// Bindings are only reachable from a request, so the Worker holds no config at
// module scope and reads it through the memoized getConfig instead.
type Env = EnvSource & { COMMITS?: Queue<QueuedJob> };

const CONFIG_INVALID = JSON.stringify({ status: 'config_invalid' });

/** Matches wrangler.jsonc queues.consumers[].max_retries: deferrals beyond this are dropped. */
const MAX_DEFERRALS = 5;
/** Cloudflare Queues caps delaySeconds at 12 hours. https://developers.cloudflare.com/queues/configuration/batching-retries/ */
const MAX_QUEUE_DELAY_SECONDS = 43_200;

// Per isolate, not per request: counters that reset on every delivery would
// make /health/detail useless, and the dedup maps exist to span requests.
const metrics = createMetrics();
const startedAt = Date.now();
setHealthDeps({ metrics, target: 'workers', startedAt });

// 7.2: exactly one info line on success and the numbered list once on failure.
// Workers cannot log at boot, so "once" is keyed on the isolate instead.
let configLogged: Config | null = null;
let configInvalidLogged = false;

function reportConfig(loaded: ConfigResult, env: Env): ConfigResult {
  if (loaded.ok) {
    if (configLogged !== loaded.config) {
      configLogged = loaded.config;
      metrics.setDropWindow(loaded.config.DROP_ALERT_WINDOW_MS);
      const log = loggerFor(loaded.config, 'workers');
      logConfigLoaded(log, loaded, env.COMMITS === undefined ? 'waitUntil' : 'cf-queue');
    }
  } else if (!configInvalidLogged) {
    configInvalidLogged = true;
    const log = createLogger({ level: 'error', target: 'workers' });
    log('error', 'config_invalid', { problems: formatProblems(loaded.problems) });
  }
  return loaded;
}

interface PerConfig {
  cfg: Config;
  deps: Deps;
  dedup: Dedup;
  routing: CompiledRouting;
}

// Rebuilt whenever the loader hands back a different Config object.
let perConfig: PerConfig | null = null;

function contextFor(cfg: Config, env: EnvSource): PerConfig {
  if (perConfig === null || perConfig.cfg !== cfg) {
    perConfig = {
      cfg,
      deps: createDeps(cfg, 'workers', metrics),
      dedup: createMemoryDedup(cfg, metrics, Date.now),
      routing: compileRoutes(cfg, env),
    };
  }
  return perConfig;
}

/** One push per invocation, so the budget is fresh per call and never shared
 *  through the cached context. */
function consume(job: RelayJob, cfg: Config, env: EnvSource, attempt: number): Promise<RelayOutcome> {
  const { deps, dedup } = contextFor(cfg, env);
  return consumeJob(job, withSubrequestBudget(deps, cfg.SUBREQUEST_BUDGET), { attempt, dedup });
}

const unsetTier: AsyncTier = {
  enqueue(job: RelayJob) {
    return Promise.reject(
      Object.assign(new Error(`no async tier available for ${job.repoFullName}`), {
        name: 'AsyncTierUnset',
      }),
    );
  },
};

// Deviation from 4.4's seam: both constructors take a Deps argument more, since
// every log line must travel through Deps; the runtime selection rule is unchanged.
// Bindings are unreachable at module scope, so the isolate's first invocation is
// the earliest their absence is observable (13.1 row 14).
let bindingAbsentLogged = false;

setAppContext({
  tier: (env, ctx) => {
    // `fetch` already reported this config; the memoized loader makes the
    // re-read free. The webhook never reaches a tier with an invalid config:
    // gate 1 answered 503 first, so the null branch only keeps the resolver total.
    const loaded = tryGetConfig(env as Env);
    if (!loaded.ok) return unsetTier;
    const cfg = loaded.config;
    const { deps } = contextFor(cfg, env);
    const bound = (env as Env).COMMITS;

    if (bound !== undefined) return new CfQueueTier(bound, deps);
    if (ctx != null) {
      if (!bindingAbsentLogged) {
        bindingAbsentLogged = true;
        deps.log('warn', 'queue_binding_absent', { tier: 'waitUntil', budgetMs: 30_000 });
      }
      return new WaitUntilTier(
        ctx as { waitUntil(promise: Promise<unknown>): void },
        (job) => consume(job, cfg, env, 1),
        deps,
      );
    }
    return unsetTier;
  },
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const config = reportConfig(tryGetConfig(env), env);
    if (!config.ok) {
      // getConfig runs before the HMAC check, so a misconfigured Worker never
      // spends CPU verifying signatures it cannot act on (7.2).
      const path = pathnameOf(request.url);
      const webhookPath = webhookPathFromEnv(env);
      if (request.method === 'POST' && path === webhookPath) {
        return new Response(CONFIG_INVALID, {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return app.fetch(request, env, ctx);
  },

  /**
   * max_batch_size is 1 (wrangler.jsonc): two pushes in one invocation blow the
   * 50-subrequest ceiling. The loop stays because that setting is config, not a guarantee.
   */
  async queue(batch: MessageBatch<QueuedJob>, env: Env): Promise<void> {
    const loaded = reportConfig(tryGetConfig(env), env);
    if (!loaded.ok) {
      // Nothing can be posted and a redelivery would fail identically, so the
      // messages are acked rather than sent round the retry loop to the DLQ.
      for (const message of batch.messages) message.ack();
      return;
    }

    const { deps, dedup, routing } = contextFor(loaded.config, env);

    for (const message of batch.messages) {
      const parsed = queuedJobSchema.safeParse(message.body);
      if (!parsed.success) {
        deps.log('error', 'queue_message_invalid', { attempt: message.attempts });
        message.ack();
        continue;
      }
      const job = parsed.data;

      if (message.attempts > 1) {
        deps.log('info', 'queue_redelivery', {
          repo: job.repoFullName,
          deliveryId: job.deliveryId,
          attempt: message.attempts,
        });
      }

      const match = routing.matchRoute(job.repoFullName, { kind: job.refKind, name: job.refName });
      if (!isRouteMatch(match)) {
        deps.log('warn', 'route_vanished', {
          repo: job.repoFullName,
          ref: job.refName,
          deliveryId: job.deliveryId,
          skipped: match.skipped,
        });
        message.ack();
        continue;
      }

      const full: RelayJob = { ...job, target: match.target, options: match.options };

      // An exception is deliberately NOT caught: an unacked message is
      // redelivered up to max_retries and then dead-lettered (13.1 row 28).
      const outcome = await consumeJob(full, withSubrequestBudget(deps, loaded.config.SUBREQUEST_BUDGET), {
        attempt: message.attempts,
        dedup,
      }).catch((error: unknown) => {
        deps.log('error', 'consumer_exception', {
          repo: job.repoFullName,
          deliveryId: job.deliveryId,
          attempt: message.attempts,
          error: String(error),
        });
        throw error;
      });

      if (isDeferred(outcome)) {
        // The service pacing us correctly, not an error: the push is re-queued from
        // the next unposted seq instead of an invocation being held asleep (13.1 row 22).
        // A retry() would resend the same body and restart from seq 0.
        const deferrals = (job.deferrals ?? 0) + 1;
        if (deferrals > MAX_DEFERRALS) {
          recordDeferredDrop(deps, full, outcome.resumeAtSeq, outcome.status, {
            tier: 'queue',
            retryAfterS: outcome.retryAfterS,
          });
          message.ack();
          continue;
        }
        const bound = env.COMMITS;
        if (bound !== undefined) {
          // A single-post job has no partial progress, so it replays whole;
          // `resumeAtSeq` exists only on a push and the compiler enforces that.
          await bound.send(
            toQueuedJob(
              full.type === 'push'
                ? { ...full, resumeAtSeq: outcome.resumeAtSeq, deferrals }
                : { ...full, deferrals },
            ),
            { delaySeconds: Math.min(outcome.retryAfterS, MAX_QUEUE_DELAY_SECONDS) },
          );
          metrics.inc('retriedTotal');
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(outcome.retryAfterS, MAX_QUEUE_DELAY_SECONDS) });
        }
        continue;
      }
      // Every terminal outcome acks, a fatal Basecamp status included: a
      // permanent config error is not made better by five more deliveries.
      message.ack();
    }
  },
};
