import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker.ts';
import type { PushJob, QueuedJob } from '../src/core/types.ts';
import { consumeJob, isDeferred } from '../src/queue/consumer.ts';
import { queuedJobSchema } from '../src/queue/queued-job-schema.ts';
import { createMemoryDedup } from '../src/queue/adapters/store-memory.ts';
import { createFakeMetrics } from './fake-metrics.ts';
import {
  configOf,
  createBasecampRecorder,
  createDeps,
  createEnv,
  createFetchRouter,
  loadFixture,
  sign,
} from './harness.ts';
import { createGitHubMock } from './mock-github.ts';
import { job as makeJob } from './push-job.ts';

/** [W] `src/worker.ts` has no injection seam, so every case terminates before an
 *  outbound call exists: the rollup exceeds CONTENT_MAX_BYTES (10.8). */

const HEALTH_TOKEN = 'health-token-0000';

/** 698 bytes of rollup against a 512-byte ceiling: fatal, and no fetch. */
const ENV = createEnv({
  CONTENT_MAX_BYTES: '512',
  FETCH_LINE_STATS: 'off',
  HEALTH_TOKEN,
  POST_RETRY_BUDGET_MS: '0',
});

/** src/obs/log.ts is the only console caller, so the NDJSON lines are read back
 *  from it rather than through an injected sink the entrypoint does not take. */
function captureLines(): () => Record<string, unknown>[] {
  const written: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    written.push(String(line));
  });
  return () => written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function createCtx(): { ctx: Ctx; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException() {},
    },
  };
}

type WorkerEnv = Parameters<typeof worker.fetch>[1];
type WorkerCtx = Parameters<typeof worker.fetch>[2];

async function push(
  env: Record<string, unknown>,
  ctx: Ctx,
  fixture = 'push.large.json',
): Promise<Response> {
  const body = loadFixture(fixture);
  const request = new Request('https://relay.example/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': crypto.randomUUID(),
      'x-hub-signature-256': await sign(body, String(env['GITHUB_WEBHOOK_SECRET'])),
    },
    body,
  });
  return worker.fetch(request, env as WorkerEnv, ctx as unknown as WorkerCtx);
}

async function pullRequest(
  env: Record<string, unknown>,
  ctx: Ctx,
  fixture = 'pr.opened.json',
): Promise<Response> {
  const body = loadFixture(fixture);
  const request = new Request('https://relay.example/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': crypto.randomUUID(),
      'x-hub-signature-256': await sign(body, String(env['GITHUB_WEBHOOK_SECRET'])),
    },
    body,
  });
  return worker.fetch(request, env as WorkerEnv, ctx as unknown as WorkerCtx);
}

async function gauges(env: Record<string, unknown>): Promise<Record<string, number>> {
  const { ctx } = createCtx();
  const res = await worker.fetch(
    new Request('https://relay.example/health/detail', {
      headers: { 'x-health-token': HEALTH_TOKEN },
    }),
    env as WorkerEnv,
    ctx as unknown as WorkerCtx,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number>;
}

describe('the binding-presence branch', () => {
  it('enqueues once per push and never posts inline when COMMITS is bound', async () => {
    const sent: PushJob[] = [];
    const env = { ...ENV, COMMITS: { send: (job: PushJob) => void sent.push(job) } };
    const { ctx, pending } = createCtx();

    const before = await gauges(env);
    const res = await push(env, ctx);

    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.rollup?.kind).toBe('cap');
    expect(pending).toHaveLength(0);

    const after = await gauges(env);
    expect(after['postedTotal']).toBe(before['postedTotal']);
    expect(after['droppedTotal']).toBe(before['droppedTotal']);
  });

  it('enqueues one pull request message and never posts inline when COMMITS is bound', async () => {
    const sent: QueuedJob[] = [];
    const env = { ...ENV, BRANCHES: 'main', COMMITS: { send: (job: QueuedJob) => void sent.push(job) } };
    const { ctx, pending } = createCtx();

    const before = await gauges(env);
    const res = await pullRequest(env, ctx);

    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(queuedJobSchema.safeParse(sent[0]).success).toBe(true);
    expect(sent[0]).toMatchObject({ type: 'pull_request' });
    expect(pending).toHaveLength(0);

    const after = await gauges(env);
    expect(after['postedTotal']).toBe(before['postedTotal']);
  });

  it('calls ctx.waitUntil exactly once and relays inline when no queue is bound', async () => {
    const env = { ...ENV };
    const { ctx, pending } = createCtx();

    const before = await gauges(env);
    const res = await push(env, ctx);

    expect(res.status).toBe(202);
    expect(pending).toHaveLength(1);

    await Promise.all(pending);
    const after = await gauges(env);
    expect((after['droppedTotal'] as number) - (before['droppedTotal'] as number)).toBe(1);
  });
});

describe('a filtered push', () => {
  it('answers 202 and moves skippedTotal on /health/detail (14.5)', async () => {
    // The fixture pushes refs/heads/main; nothing here allows that branch.
    const env = { ...ENV, BRANCHES: 'release/*' };
    const { ctx, pending } = createCtx();

    const before = await gauges(env);
    const res = await push(env, ctx);

    expect(res.status).toBe(202);
    expect(pending).toHaveLength(0);

    const after = await gauges(env);
    expect((after['skippedTotal'] as number) - (before['skippedTotal'] as number)).toBe(1);
  });
});

describe('the queue handler', () => {
  interface FakeMessage {
    body: PushJob;
    attempts: number;
    acks: number;
    retries: Array<{ delaySeconds?: number }>;
  }

  function batch(job: PushJob, attempts = 1): { batch: unknown; message: FakeMessage } {
    const message: FakeMessage = { body: job, attempts, acks: 0, retries: [] };
    return {
      message,
      batch: {
        queue: 'commits',
        messages: [
          {
            id: 'message-1',
            timestamp: new Date(0),
            body: job,
            attempts,
            ack: () => void (message.acks += 1),
            retry: (options?: { delaySeconds?: number }) => void message.retries.push(options ?? {}),
          },
        ],
      },
    };
  }

  const rollupJob = (): PushJob =>
    makeJob({
      commits: [],
      rollup: {
        kind: 'cap',
        fileCount: 31,
        authors: ['jane-doe', 'sam-lee'],
      },
    });

  it('processes a batch message and acks a terminal outcome', async () => {
    const env = { ...ENV };
    const { batch: b, message } = batch(rollupJob());
    const lines = captureLines();

    const before = await gauges(env);
    await worker.queue(
      b as Parameters<typeof worker.queue>[0],
      env as Parameters<typeof worker.queue>[1],
    );

    expect(message.acks).toBe(1);
    expect(message.retries).toHaveLength(0);
    const after = await gauges(env);
    expect((after['droppedTotal'] as number) - (before['droppedTotal'] as number)).toBe(1);

    // 7.2: exactly one config_loaded line, carrying the loader's summary.
    const loaded = lines().filter((line) => line['evt'] === 'config_loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ lvl: 'info', tgt: 'workers', asyncTier: 'waitUntil' });
    expect(loaded[0]).toHaveProperty('fallthrough');
    expect(loaded[0]).toHaveProperty('lineStats');
    expect(loaded[0]).toHaveProperty('tokens');
  });

  it('acks rather than dead-letters when the config cannot boot', async () => {
    const { batch: b, message } = batch(rollupJob());
    const lines = captureLines();

    await worker.queue(
      b as Parameters<typeof worker.queue>[0],
      { GITHUB_WEBHOOK_SECRET: 'too-short' } as Parameters<typeof worker.queue>[1],
    );

    expect(message.acks).toBe(1);
    expect(message.retries).toHaveLength(0);

    // 7.2: the numbered human list, not the bare key names.
    const invalid = lines().filter((line) => line['evt'] === 'config_invalid');
    expect(invalid).toHaveLength(1);
    expect(String(invalid[0]?.['problems'])).toContain(
      '1. GITHUB_WEBHOOK_SECRET must be at least 32 characters.',
    );
  });
});

describe('the fetch entrypoint', () => {
  it('answers 503 on /webhook and 500 on /healthz when the config cannot boot', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: 'too-short' };
    const { ctx } = createCtx();

    const webhook = await push(env, ctx);
    expect(webhook.status).toBe(503);

    const health = await worker.fetch(
      new Request('https://relay.example/healthz'),
      env as WorkerEnv,
      ctx as unknown as WorkerCtx,
    );
    expect(health.status).toBe(500);
  });
});

/** 15.2 queue rows needing a real Basecamp status. `fetchMock` is gone from
 *  `cloudflare:test`, and `src/worker.ts` binds `globalThis.fetch` with no seam,
 *  so these run at the `consumeJob` boundary on the suite's injected fetch and
 *  apply the handler's own ack/retry rule. `worker.queue` itself is driven
 *  end-to-end against a real listener in tests/e2e.worker-queue.node.test.ts. */
describe('the queue handler against a Basecamp status', () => {
  interface FakeMessage {
    acks: number;
    retries: Array<{ delaySeconds?: number }>;
  }

  const POSTING_ENV = createEnv({
    BASECAMP_MIN_INTERVAL_MS: '0',
    FETCH_LINE_STATS: 'off',
    HEALTH_TOKEN,
    POST_RETRY_BUDGET_MS: '0',
    RATELIMIT_WAIT_BUDGET_MS: '0',
  });

  function rig(basecampStatus: number, headers: Record<string, string> = {}) {
    const config = configOf(POSTING_ENV);
    const basecamp = createBasecampRecorder(() => ({ status: basecampStatus, headers }));
    const metrics = createFakeMetrics();
    const deps = createDeps({
      config,
      fetchImpl: createFetchRouter(createGitHubMock(), basecamp),
      metrics,
    });
    return { deps, basecamp, metrics, dedup: createMemoryDedup(config, metrics, Date.now) };
  }

  /** A deferred outcome is terminal at the consumeJob boundary: the worker
   *  re-enqueues and acks; this test asserts the deferral signal only. */
  async function deliver(
    rigged: ReturnType<typeof rig>,
    deliveryId: string,
  ): Promise<FakeMessage> {
    const message: FakeMessage = { acks: 0, retries: [] };
    const outcome = await consumeJob(
      makeJob({
        deliveryId,
        commits: [],
        rollup: { kind: 'cap', fileCount: 31, authors: ['jane-doe', 'sam-lee'] },
      }),
      rigged.deps,
      { attempt: 1, dedup: rigged.dedup },
    );
    if (isDeferred(outcome)) {
      rigged.metrics.inc('retriedTotal');
      message.acks += 1;
    } else {
      message.acks += 1;
    }
    return message;
  }

  it('defers on a 429 beyond the wait budget', async () => {
    const rigged = rig(429, { 'retry-after': '7' });

    const message = await deliver(rigged, 'delivery-429');

    expect(message.acks).toBe(1);
    expect(message.retries).toHaveLength(0);
    expect(rigged.basecamp.calls).toHaveLength(1);

    expect(rigged.metrics.values.retriedTotal).toBe(1);
    expect(rigged.metrics.values.lastBasecampStatus).toBe(429);
  });

  it('acks without retrying and records the failure on a fatal 403', async () => {
    const rigged = rig(403);

    const message = await deliver(rigged, 'delivery-403');

    expect(message.acks).toBe(1);
    expect(message.retries).toHaveLength(0);
    expect(rigged.basecamp.calls).toHaveLength(1);

    expect(rigged.metrics.values.failedTotal).toBe(1);
    expect(rigged.metrics.values.lastBasecampStatus).toBe(403);
    // 403 (bot removed from the Campfire) latches config-health like 401/404.
    expect(rigged.metrics.values.configHealthy).toBe(0);
  });
});

describe('invalid config on GET', () => {
  it('returns 404 for GET on the webhook path', async () => {
    const env = createEnv({ GITHUB_WEBHOOK_SECRET: "It's a Secret to Everybody" });
    const { ctx } = createCtx();
    const res = await worker.fetch(
      new Request('https://relay.example/webhook', { method: 'GET' }),
      env as WorkerEnv,
      ctx as unknown as WorkerCtx,
    );
    expect(res.status).toBe(404);
  });
});
