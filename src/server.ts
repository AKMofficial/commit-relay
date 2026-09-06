import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { readConfigFile } from './config/file.ts';
import { formatProblems, logConfigLoaded, tryGetConfig } from './config/load.ts';
import { type Deps, createDeps } from './runtime/deps.ts';
import type { RelayJob } from './core/types.ts';
import { app, setAppContext } from './http/app.ts';
import { setHealthDeps } from './http/health.ts';
import { createLifecycle } from './lifecycle.ts';
import { createLogger, loggerFor, throttled } from './obs/log.ts';
import { createMetrics } from './obs/metrics.ts';
import { consumeJob } from './queue/consumer.ts';
import { MemoryFifoTier, type RunMode } from './queue/adapters/memory-fifo.ts';
import { createMemoryDedup } from './queue/adapters/store-memory.ts';

// A slow-loris body must not pin a socket, and neither timeout has a useful
// default in node's http server (11.1).
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** The margin of 16.2.3: SIGKILL must not land while the drain is still running. */
const DRAIN_MARGIN_MS = 5_000;

function isHttpServer(value: unknown): value is Server {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as Server).close === 'function'
    && typeof (value as Server).closeIdleConnections === 'function'
    && typeof (value as Server).closeAllConnections === 'function'
  );
}

/** Long enough for the NDJSON writes already queued on stdout to flush. */
const FATAL_FLUSH_MS = 200;

// One stable object: tryGetConfig memoizes on source identity, so a fresh copy
// per request would re-validate config and rebuild the rate limiter (7.2).
const envSource = { ...process.env };

// Node can refuse to start, so validation is eager here and lazy on Workers; a
// stack trace tells an operator nothing, so the numbered list is the whole output.
const loaded = tryGetConfig(envSource, { readFile: readConfigFile });
if (!loaded.ok) {
  process.stderr.write(formatProblems(loaded.problems));
  // The config is what failed, so the fatal line of 14.2 comes from a logger
  // that depends on none of it (row 32).
  createLogger({ level: 'fatal', target: 'node' })('fatal', 'config_invalid', {
    problems: loaded.problems.length,
    missing: loaded.missing,
  });
  process.exit(1);
}

const config = loaded.config;
const log = loggerFor(config, 'node');
const metrics = createMetrics(config.DROP_ALERT_WINDOW_MS);
const lifecycle = createLifecycle();
const startedAt = Date.now();

const deps = createDeps(config, 'node', metrics);

// A drain never starts new GitHub enrichment: turning stats off force-promotes
// pending jobs with N/A, because partial data beats a lost message (16.2.3).
const drainDeps: Deps = { ...deps, config: { ...config, FETCH_LINE_STATS: 'off' } };

const dedup = createMemoryDedup(config, metrics, Date.now);

const tier = new MemoryFifoTier({
  deps,
  maxDepth: config.MAX_QUEUE_DEPTH,
  maxBytes: config.MAX_QUEUE_BYTES,
  rateLimitBudgetMs: config.RATELIMIT_WAIT_BUDGET_MS,
  run: (job: RelayJob, mode: RunMode) =>
    consumeJob(job, mode === 'drain' ? drainDeps : deps, { dedup }),
});

// The listener's own env is the only place the TCP peer address exists; keyed on
// the Request so the config object stays the single stable one (9.3).
const peers = new WeakMap<Request, string>();

setAppContext({
  tier: () => tier,
  socketAddress: (request) => peers.get(request) ?? null,
});

setHealthDeps({
  metrics,
  target: 'node',
  startedAt,
  isServing: () => lifecycle.isServing(),
  rss: () => Math.round(process.memoryUsage.rss() / 1_048_576),
});

logConfigLoaded(log, loaded, 'memory-fifo');

// Dedup, ordering and the pacer are per-process state, so a second replica
// produces duplicate, out-of-order messages (16.2.4).
const replicaIndex = Number(
  process.env['RAILWAY_REPLICA_INDEX'] ?? process.env['FLY_ALLOC_INDEX'] ?? '0',
);
if (Number.isFinite(replicaIndex) && replicaIndex !== 0) {
  log('warn', 'replica_index_nonzero', { index: replicaIndex });
}

// SHUTDOWN_DRAIN_MS + 5000 <= drainingSeconds * 1000 (16.2.3); drainingSeconds
// lives in railway.json, so the check needs the platform to export it too.
const drainBudgetMs = config.SHUTDOWN_DRAIN_MS + DRAIN_MARGIN_MS;
const drainingSeconds = Number(process.env['RAILWAY_DRAINING_SECONDS'] ?? '');
if (Number.isFinite(drainingSeconds) && drainingSeconds > 0) {
  if (drainingSeconds * 1000 < drainBudgetMs) {
    log('warn', 'drain_budget_exceeded', { drainBudgetMs, drainingSeconds });
  }
} else {
  log('warn', 'drain_budget_unverified', {
    drainBudgetMs,
    requiredDrainingSeconds: Math.ceil(drainBudgetMs / 1000),
  });
}

// Three times the per-request cap: above it the process sheds rather than
// letting concurrent 26 MB bodies co-exist in a capped heap (11.1). Bytes are
// charged as they arrive, not from the declared Content-Length alone.
const IN_FLIGHT_MAX_BYTES = config.MAX_BODY_BYTES * 3;
let inFlightBytes = 0;

const server = serve(
  {
    fetch: (request: Request, env: { incoming?: { socket?: { remoteAddress?: unknown } } }) => {
      const raw = request.headers.get('content-length');
      const declared = raw === null || raw === '' ? NaN : Number(raw);
      // GitHub always sends Content-Length; chunked bodies are unbounded until read.
      if (request.method !== 'GET' && (!Number.isInteger(declared) || declared < 0)) {
        const slashIdx = request.url.indexOf('/', 8);
        const path = slashIdx === -1 ? '' : request.url.slice(slashIdx);
        log('warn', 'content_length_required', {
          method: request.method,
          path,
        });
        return new Response(null, { status: 411 });
      }
      if (declared > 0 && inFlightBytes + declared > IN_FLIGHT_MAX_BYTES) {
        log('warn', 'in_flight_bytes_exceeded', { inFlightBytes, cost: declared });
        return new Response(null, { status: 503, headers: { 'Retry-After': '5' } });
      }

      let reserved = 0;
      let req = request;
      if (request.method !== 'GET' && request.body !== null) {
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            inFlightBytes += chunk.byteLength;
            reserved += chunk.byteLength;
            if (inFlightBytes > IN_FLIGHT_MAX_BYTES) {
              if (throttled('in_flight', 60_000, Date.now())) {
                log('warn', 'in_flight_bytes_exceeded', { inFlightBytes });
              }
              controller.error(new Error('in_flight_bytes_exceeded'));
              return;
            }
            controller.enqueue(chunk);
          },
        });
        req = new Request(request, {
          body: request.body.pipeThrough(counter),
          duplex: 'half',
        } as RequestInit);
      }

      const address = env.incoming?.socket?.remoteAddress;
      if (typeof address === 'string' && address !== '') peers.set(req, address);

      return Promise.resolve(app.fetch(req, envSource)).finally(() => {
        inFlightBytes -= reserved;
      });
    },
    port: config.PORT,
    serverOptions: {
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      connectionsCheckingInterval: 5_000,
    },
  },
  (info) => {
    lifecycle.ready();
    log('info', 'server_listening', { port: info.port });
  },
);

async function shutdown(signal: string): Promise<void> {
  // 1. /healthz answers 503 as the first act, before anything else (16.2.3).
  if (!lifecycle.drain()) return;
  log('info', 'server_draining', { signal });

  // Hanging gets SIGKILLed and loses more than exiting does. unref'd so it
  // never keeps an already-drained process alive.
  const hard = setTimeout(() => {
    log('error', 'drain_timeout', { signal });
    process.exit(0);
  }, config.SHUTDOWN_DRAIN_MS + DRAIN_MARGIN_MS);
  hard.unref();

  // 2. stop accepting new connections; in-flight requests finish.
  const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
  if (isHttpServer(server)) server.closeIdleConnections();

  // 3. drain the FIFO at the normal pace, up to SHUTDOWN_DRAIN_MS.
  const report = await tier.drain(config.SHUTDOWN_DRAIN_MS);

  // 4. name whatever was lost, so it can be redelivered by hand.
  if (report.remaining.length === 0) {
    log('info', 'drain_complete', { posted: report.posted, dropped: report.dropped });
  } else {
    log('error', 'drain_incomplete', { remaining: report.remaining.length });
    log('error', 'jobs_lost', { count: report.jobs, shas: report.remaining });
  }

  if (isHttpServer(server)) server.closeAllConnections();
  await closePromise;

  lifecycle.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Crashing loudly beats running wrong: Railway's ON_FAILURE policy restarts.
function fatal(evt: string, error: unknown): void {
  lifecycle.drain();
  log('fatal', evt, { error: String(error) });
  setTimeout(() => process.exit(1), FATAL_FLUSH_MS);
}

process.on('unhandledRejection', (reason) => fatal('unhandled', reason));
process.on('uncaughtException', (error) => fatal('unhandled', error));
