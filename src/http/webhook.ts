/** Gates 0-10 of 9.3, in order. Nothing above the trust boundary parses,
 *  allocates per commit, or fetches before verify resolves true (11.1). */

import { readValue } from '../config/env.ts';
import { tryGetConfig, type LoadOptions } from '../config/load.ts';
import { compileRoutes } from '../config/routing.ts';
import { DEFAULT_WEBHOOK_PATH, type Config } from '../config/schema.ts';
import type { EnvSource } from '../config/env.ts';
import { readCapped } from '../core/bytes.ts';
import type { LogFn } from '../obs/log.ts';
import type {
  CompiledRouting,
  PullRequestEvent,
  PullRequestJob,
  PushEvent,
  PushJob,
  RelayJob,
} from '../core/types.ts';
import { rollupAuthors } from '../core/types.ts';
import {
  decidePullRequest,
  decidePush,
  type PullRequestDecision,
  type PushDecision,
} from '../github/filter.ts';
import { parsePullRequest, parsePullRequestReview, parsePush } from '../github/parse.ts';
import { loggerFor, payloadsEnabled, type Target } from '../obs/log.ts';
import { QueueFullError, type AsyncTier } from '../queue/types.ts';
import { verifySignature } from '../security/hmac.ts';
import { resolveClientIp } from './clientip.ts';
import { healthDeps } from './health.ts';
import { createRateLimiter, type RateLimiter } from './ratelimit.ts';

/** Classification for the log line only; the accept/reject decision is
 *  verifySignature's, which applies the identical gate itself. */
const SIGNATURE_SHAPE = /^sha256=[0-9a-f]{64}$/;
const DELIVERY_ID = /^[0-9a-fA-F-]{1,64}$/;

const AUTH_COLLAPSE_MS = 3_600_000;

/** The collapse map is keyed on attacker-chosen data in the pre-auth path, so it
 *  is bounded exactly like the dedup maps of 11.1. */
const AUTH_MAX_KEYS = 10_000;

const CONTENT_TYPE_HINT =
  'Set the webhook Content type to application/json on the GitHub hook settings page.';

const TEXT_DECODER = new TextDecoder();

/** Returns null when the URL cannot be parsed; callers must not load config for it. */
export function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export function webhookPathFromEnv(env: EnvSource): string {
  const raw = env['WEBHOOK_PATH'];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || DEFAULT_WEBHOOK_PATH;
}

/** A resolver rather than an instance: on Workers the tier depends on the
 *  binding object and ExecutionContext, neither of which exists at module scope. */
export type ResolveTier = (env: EnvSource, ctx: unknown) => AsyncTier;

export interface WebhookOptions {
  resolveTier: ResolveTier;
  target: Target;
  now?: () => number;
  /** Overrides the logger built from LOG_LEVEL; tests observe evts through it. */
  log?: LogFn;
  /** Seam for the tests that must prove verification was never reached. */
  verify?: typeof verifySignature;
  /** Node listeners that expose their TCP peer pass a resolver; Workers does not. */
  socketAddress?: (request: Request, env: EnvSource) => string | null;
  load?: LoadOptions;
}

/** Gates 0 and 1. `app.ts` runs this ahead of `hono/body-limit`, which buffers a
 *  chunked body whole before the handler is reached; gate 1 must stay in front
 *  of that allocation (9.3, 11.1). */
export type PreflightResult =
  | { response: Response; cfg: null }
  | {
      response: null;
      cfg: Config;
      log: LogFn;
      ip: string;
      /** Refunds the gate-1 global token once gate 4 verifies the request. */
      creditRateLimit: () => void;
      routing: CompiledRouting;
      secrets: WebhookSecret[];
    };

export interface WebhookHandler {
  (request: Request, env: EnvSource, pre?: PreflightResult, ctx?: unknown): Promise<Response>;
  preflight(request: Request, env: EnvSource): Promise<PreflightResult>;
}

/** One candidate secret. `envName` is null for the global secret and names the
 *  route's `webhookSecretEnv` otherwise; it is what the post-parse route check
 *  compares against (11.1, "cross-repo forgery with a shared secret"). */
export interface WebhookSecret {
  envName: string | null;
  secret: string;
}

/**
 * The repo is unknown until after verification, so the handler cannot pick one
 * secret: it tries each, then requires the match to belong to the repo's route.
 */
function resolveWebhookSecrets(cfg: Config, source: EnvSource): WebhookSecret[] {
  const out: WebhookSecret[] = [{ envName: null, secret: cfg.GITHUB_WEBHOOK_SECRET }];
  for (const route of cfg.ROUTES?.routes ?? []) {
    const name = route.webhookSecretEnv;
    if (name === undefined) continue;
    if (out.some((candidate) => candidate.envName === name)) continue;
    const secret = readValue(source, name);
    if (secret === undefined || secret === '') continue;
    out.push({ envName: name, secret });
  }
  return out;
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function isPullRequestEvent(event: PushEvent | PullRequestEvent): event is PullRequestEvent {
  return 'action' in event;
}

async function enqueueOrShed(job: RelayJob, tier: AsyncTier, log: LogFn): Promise<Response> {
  try {
    await tier.enqueue(job);
  } catch (error) {
    if (!(error instanceof QueueFullError)) throw error;
    log('error', 'queue_overflow', {
      deliveryId: job.deliveryId,
      repo: job.repoFullName,
      ref: job.type === 'push' ? job.ref : job.refName,
      dropped: job.type === 'push' ? job.commits.length : 1,
    });
    return new Response(null, {
      status: 503,
      headers: { 'Retry-After': String(error.retryAfterSeconds ?? 10) },
    });
  }

  if (job.type === 'pull_request') {
    log('debug', 'pull_request_enqueued', {
      repo: job.repoFullName,
      pr: job.number,
      prKind: job.kind,
      deliveryId: job.deliveryId,
    });
  } else {
    log('debug', 'push_enqueued', {
      repo: job.repoFullName,
      ref: job.ref,
      deliveryId: job.deliveryId,
      commits: job.commits.length,
      rollup: job.rollup?.kind ?? null,
    });
  }
  return empty(202);
}

function buildJob(
  event: PushEvent,
  decision: Exclude<PushDecision, { kind: 'skip' }>,
  deliveryId: string,
): PushJob {
  const commits =
    decision.kind === 'rollup'
      ? []
      : decision.commits.map((commit) =>
          decision.mergeCandidates.has(commit.id) ? { ...commit, mergeCandidate: true } : commit,
        );

  return {
    type: 'push',
    deliveryId,
    repoFullName: event.repoFullName,
    ref: event.ref,
    refKind: decision.ref.kind,
    refName: decision.ref.name,
    before: event.before,
    after: event.after,
    compareUrl: event.compare,
    forced: event.forced,
    created: event.created,
    changedPathCount: event.changedPathCount,
    commits,
    ...(decision.kind === 'rollup'
      ? {
          rollup: {
            kind: decision.rollupKind,
            fileCount: event.changedPathCount,
            authors: rollupAuthors(decision.commits),
          },
        }
      : {}),
    target: decision.route.target,
    options: decision.route.options,
  };
}

function buildPullRequestJob(
  event: PullRequestEvent,
  decision: Extract<PullRequestDecision, { kind: 'post' }>,
  deliveryId: string,
): PullRequestJob {
  return {
    type: 'pull_request',
    kind: decision.prKind,
    deliveryId,
    repoFullName: event.repoFullName,
    // The base branch: what the pull request targets is what routes it.
    refKind: decision.ref.kind,
    refName: decision.ref.name,
    number: event.number,
    title: event.title,
    htmlUrl: event.htmlUrl,
    headRef: event.headRef,
    headSha: event.headSha,
    author: event.author,
    fileCount: event.fileCount,
    additions: event.additions,
    deletions: event.deletions,
    ...(event.reviewId === undefined ? {} : { reviewId: event.reviewId }),
    target: decision.route.target,
    options: decision.route.options,
  };
}

export function createWebhookHandler(options: WebhookOptions): WebhookHandler {
  const now = options.now ?? Date.now;
  const verify = options.verify ?? verifySignature;
  const authLoggedAt = new Map<string, number>();
  /** Rebuilt whenever the loader hands back a different Config, so a changed
   *  LOG_LEVEL or RATE_LIMIT_PER_MINUTE cannot be masked by the first one seen. */
  let memo: {
    cfg: Config;
    log: LogFn;
    limiter: RateLimiter;
    routing: CompiledRouting;
    secrets: WebhookSecret[];
  } | null = null;

  /** Repeated auth failures collapse to one line per hour (14.2), keyed on the
   *  repo where known and otherwise the IP, the only thing knowable pre-auth. */
  function shouldLogAuthFailure(ip: string, at: number): boolean {
    const last = authLoggedAt.get(ip);
    if (last !== undefined && at - last < AUTH_COLLAPSE_MS) return false;
    if (authLoggedAt.size >= AUTH_MAX_KEYS) {
      // An entry past the window can no longer suppress anything, so dropping it
      // is free; if none has expired the oldest insertion goes instead.
      for (const [key, when] of authLoggedAt) {
        if (at - when >= AUTH_COLLAPSE_MS) authLoggedAt.delete(key);
      }
      if (authLoggedAt.size >= AUTH_MAX_KEYS) {
        const oldest = authLoggedAt.keys().next();
        if (!oldest.done) authLoggedAt.delete(oldest.value);
      }
    }
    authLoggedAt.set(ip, at);
    return true;
  }

  async function preflight(request: Request, env: EnvSource): Promise<PreflightResult> {
    const path = pathnameOf(request.url);
    if (path === null) {
      return { response: empty(400), cfg: null };
    }
    const loaded = tryGetConfig(env, options.load ?? {});

    if (!loaded.ok) {
      const configuredPath = webhookPathFromEnv(env);
      if (request.method !== 'POST' || path !== configuredPath) {
        return { response: empty(404), cfg: null };
      }
      // Fixed body: /healthz is the endpoint that names the missing variables.
      return { response: new Response('service unavailable', { status: 503 }), cfg: null };
    }

    const cfg = loaded.config;
    if (memo === null || memo.cfg !== cfg) {
      const log =
        options.log ?? loggerFor(cfg, options.target);
      try {
        memo = {
          cfg,
          log,
          limiter: createRateLimiter({ perMinute: cfg.RATE_LIMIT_PER_MINUTE, now }),
          routing: compileRoutes(cfg, env),
          secrets: resolveWebhookSecrets(cfg, env),
        };
      } catch {
        log('error', 'config_invalid', { reason: 'glob_compile' });
        return { response: new Response('service unavailable', { status: 503 }), cfg: null };
      }
    }
    const { log, limiter } = memo;

    // ---- gate 0: path / method ----
    if (request.method !== 'POST' || path !== cfg.WEBHOOK_PATH) {
      return { response: empty(404), cfg: null };
    }

    // ---- gate 1: rate limit, ahead of the signature check ----
    const ip = resolveClientIp(request.headers, {
      target: options.target,
      trustedProxyHops: cfg.TRUSTED_PROXY_HOPS,
      socketAddress: options.socketAddress?.(request, env) ?? null,
      log,
    });
    // The free shape test decides which global half pays; the refund after gate 4
    // is what actually protects verified traffic (see ratelimit.ts).
    const signed = SIGNATURE_SHAPE.test(request.headers.get('x-hub-signature-256') ?? '');
    const decision = limiter.check(ip, signed);
    if (!decision.allowed) {
      log('warn', 'rate_limited', { ip, scope: decision.scope });
      return {
        response: new Response(null, {
          status: 429,
          headers: { 'Retry-After': String(decision.retryAfterSeconds) },
        }),
        cfg: null,
      };
    }

    return {
      response: null,
      cfg,
      log,
      ip,
      creditRateLimit: () => { limiter.credit(signed); },
      routing: memo.routing,
      secrets: memo.secrets,
    };
  }

  const handle = async function handle(
    request: Request,
    env: EnvSource,
    pre?: PreflightResult,
    ctx?: unknown,
  ): Promise<Response> {
    const gate01 = pre ?? (await preflight(request, env));
    if (gate01.response !== null) return gate01.response;
    const { cfg, log, ip, creditRateLimit, routing, secrets } = gate01;

    // ---- gate 2: content type, prefix-matched on the media type ----
    const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
    if (!contentType.startsWith('application/json')) {
      log('warn', 'webhook_bad_content_type', { ip, contentType, hint: CONTENT_TYPE_HINT });
      return new Response('unsupported media type', { status: 415 });
    }

    // ---- gate 3: size cap ----
    const declared = Number(request.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > cfg.MAX_BODY_BYTES) {
      log('warn', 'webhook_body_too_large', { ip, declared });
      return empty(413);
    }
    let raw: Uint8Array<ArrayBuffer> | null;
    try {
      raw = await readCapped(request.body, cfg.MAX_BODY_BYTES);
    } catch {
      log('warn', 'webhook_body_aborted', { ip });
      return empty(400);
    }
    if (raw === null) {
      log('warn', 'webhook_body_too_large', { ip, declared: null });
      return empty(413);
    }

    // ---- gate 4: signature ----
    // Verified against every configured secret, recording which matched; with no
    // per-route secret there is one candidate and one verify call (11.1).
    const header = request.headers.get('x-hub-signature-256');
    const matchedEnvNames = new Set<string | null>();
    for (const candidate of secrets) {
      if (await verify(raw, header, candidate.secret)) matchedEnvNames.add(candidate.envName);
    }
    if (matchedEnvNames.size === 0) {
      const evt =
        header === null
          ? 'webhook_signature_missing'
          : SIGNATURE_SHAPE.test(header)
            ? 'webhook_signature_invalid'
            : 'webhook_signature_malformed';
      // The client IP only: never the supplied header, never a computed digest,
      // never which of the three cases it was.
      if (shouldLogAuthFailure(ip, now())) log('warn', evt, { ip });
      return new Response('unauthorized', { status: 401 });
    }

    // Verified: refund the global token spent at gate 1. The per-IP token stays spent.
    creditRateLimit();

    // ---------------- trust boundary ----------------

    let deliveryId = request.headers.get('x-github-delivery');
    if (deliveryId !== null && !DELIVERY_ID.test(deliveryId)) {
      if (shouldLogAuthFailure(ip, now())) log('warn', 'webhook_delivery_id_invalid', { ip });
      deliveryId = null;
    }
    const event = request.headers.get('x-github-event');
    const hookId = request.headers.get('x-github-hook-id');
    const targetType = request.headers.get('x-github-hook-installation-target-type');

    // ---- gate 5: the event header ----
    if (event === null) {
      log('warn', 'webhook_event_header_missing', { deliveryId, ip });
      return new Response(null, { status: 400 });
    }

    // ---- gate 6: ping. No commits, nothing enqueued, so 204 and not 202. ----
    if (event === 'ping') {
      log('info', 'webhook_ping', { deliveryId, hookId, targetType });
      return empty(204);
    }

    // ---- gate 7: every other event ----
    const isPullRequest = event === 'pull_request' || event === 'pull_request_review';
    if (event !== 'push' && !isPullRequest) {
      log('debug', 'event_ignored', { deliveryId, event });
      return empty(204);
    }

    // ---- gate 8: JSON, parsed from the SAME bytes that were verified ----
    let payload: unknown;
    const text = TEXT_DECODER.decode(raw);
    try {
      payload = JSON.parse(text);
    } catch {
      log('error', 'payload_unparseable', { deliveryId, ip, bytes: raw.byteLength });
      return new Response(null, { status: 400 });
    }

    // Guarded rather than left to the logger's own gate, so a 25 MB body is
    // not decoded a second time on every delivery just to be discarded (14.2).
    if (payloadsEnabled(cfg)) {
      log('trace', 'payload_received', { deliveryId, bytes: raw.byteLength, body: text });
    }

    // ---- gate 9: shape. Lenient by design: only the paths of 9.4. ----
    const parseLimits = {
      commitBodyMaxChars: cfg.COMMIT_BODY_MAX_CHARS,
      deliveryId: deliveryId ?? undefined,
    };
    const parsed = isPullRequest
      ? event === 'pull_request_review'
        ? parsePullRequestReview(payload, parseLimits, log)
        : parsePullRequest(payload, parseLimits, log)
      : parsePush(payload, parseLimits, log);
    if (!parsed.ok) {
      log('warn', 'payload_unrecognized', { deliveryId, ip, issues: parsed.issues });
      return empty(422);
    }
    const repoFullName = parsed.event.repoFullName;

    // Hoisted above the per-event branch: it needs only the repository, and it
    // is the cross-repo forgery defence, so it has to guard every event.
    const expectedEnvName = routing.expectedSecretEnv(repoFullName);
    if (expectedEnvName !== undefined && !matchedEnvNames.has(expectedEnvName)) {
      if (shouldLogAuthFailure(`repo:${repoFullName}`, now())) {
        log('warn', 'webhook_secret_route_mismatch', { deliveryId, repo: repoFullName });
      }
      return new Response('unauthorized', { status: 401 });
    }

    const decideCtx = {
      log,
      deliveryId: deliveryId ?? '',
      // Read per request from the registered store, so `skippedTotal` moves
      // exactly as /health/detail reports it (14.5).
      metrics: healthDeps().metrics,
    };

    // ---- gate 10: filter, route, enqueue. Everything here answers 202. ----
    let job: RelayJob;
    if (isPullRequestEvent(parsed.event)) {
      const prDecision = decidePullRequest(parsed.event, routing, decideCtx);
      if (prDecision.kind === 'skip') return empty(202);
      job = buildPullRequestJob(parsed.event, prDecision, deliveryId ?? '');
    } else {
      const decision = decidePush(parsed.event, routing, decideCtx);
      if (decision.kind === 'skip') return empty(202);
      job = buildJob(parsed.event, decision, deliveryId ?? '');
    }

    return enqueueOrShed(job, options.resolveTier(env, ctx), log);
  } as WebhookHandler;

  handle.preflight = preflight;
  return handle;
}
