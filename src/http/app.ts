import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { healthDeps, healthDetail, healthz } from './health.ts';
import { createWebhookHandler, type PreflightResult, type ResolveTier } from './webhook.ts';
import type { EnvSource } from '../config/env.ts';
import type { AsyncTier } from '../queue/types.ts';
import { createLogger } from '../obs/log.ts';

type Preflighted = Extract<PreflightResult, { response: null }>;

/** nodejs_compat is off permanently (4.5, wrangler.jsonc), so the absence of
 *  `process` is exactly the entry that built this module: src/worker.ts. */
const target = typeof (globalThis as { process?: unknown }).process === 'undefined' ? 'workers' : 'node';

const appLog = createLogger({ level: 'error', target });

export const app = new Hono<{ Variables: { pre: Preflighted } }>();

app.onError((err, c) => {
  appLog('error', 'unhandled_request_error', { name: err instanceof Error ? err.name : 'unknown' });
  return c.body(null, 500);
});
app.notFound((c) => c.body(null, 404));

/** The tier is a resolver because on Workers it depends on the binding object
 *  and the ExecutionContext, neither reachable from module scope. */
export interface AppContext {
  tier: ResolveTier;
  socketAddress?: (request: Request, env: EnvSource) => string | null;
}

/** The unconfigured default: gates 0-10 run, nothing is relayed. Both entrypoints
 *  call setAppContext at module scope, so only gate-asserting tests reach it. */
let context: AppContext = {
  tier: () => ({ enqueue: () => Promise.resolve() }),
};

export function setAppContext(next: AppContext): void {
  context = next;
}

/** Reads the peer off the listener's `incoming` message on the env object, so
 *  nothing here imports node:*. */
function socketAddress(request: Request, env: EnvSource): string | null {
  if (context.socketAddress !== undefined) return context.socketAddress(request, env);
  const incoming = (env as unknown as { incoming?: { socket?: { remoteAddress?: unknown } } })
    .incoming;
  const address = incoming?.socket?.remoteAddress;
  return typeof address === 'string' && address !== '' ? address : null;
}

const webhook = createWebhookHandler({
  target,
  socketAddress,
  resolveTier: (env, ctx): AsyncTier => context.tier(env, ctx),
});

app.get('/healthz', (c) => {
  // On Workers c.env is the binding object; src/server.ts passes process.env.
  const { code, body } = healthz(c.env as EnvSource);
  return c.json(body, code);
});

app.get('/health/detail', async (c) => {
  const { code, body } = await healthDetail(c.req.raw, c.env as EnvSource, {}, { ...healthDeps(), target });
  return c.json(body, code);
});

// A wildcard, because WEBHOOK_PATH lives in a config object that cannot be read
// at module scope on Workers; the handler compares the path itself and 404s.
app.post(
  '*',
  // 9.3 gate 1: bodyLimit buffers a chunked body whole before next(), and an
  // unauthenticated flood must not reach that allocation (11.1).
  async (c, next) => {
    const pre = await webhook.preflight(c.req.raw, c.env as EnvSource);
    if (pre.response !== null) return pre.response;
    c.set('pre', pre);
    await next();
  },
  // Built per request because MAX_BODY_BYTES is only reachable from a request on
  // Workers; preflight loaded it, so mount and counter cannot disagree (9.3 gate 3).
  (c, next) => {
    const pre = c.get('pre');
    return bodyLimit({
      maxSize: pre.cfg.MAX_BODY_BYTES,
      // bodyLimit rejects before the handler's own counter can run, so gate 3's
      // log line is emitted here or nowhere (9.3 gate 3, 13.1 row 5).
      onError: (errCtx) => {
        pre.log('warn', 'webhook_body_too_large', {
          ip: pre.ip,
          declared: errCtx.req.header('content-length') ?? null,
        });
        return errCtx.body(null, 413);
      },
    })(c, next);
  },
  (c) => {
    // hono throws rather than returning undefined when no ExecutionContext was
    // supplied, the ordinary case on Node.
    let ctx: unknown;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }
    return webhook(c.req.raw, c.env as EnvSource, c.get('pre'), ctx);
  },
);

export default app;
