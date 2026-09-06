import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './worker.ts';
import type { PushJob, QueuedJob } from './core/types.ts';
import { toQueuedJob } from './core/types.ts';
import { createEnv } from '../tests/harness.ts';
import { commit, job as makeJob, asQueuedPush } from '../tests/push-job.ts';

/** Deferred pushes are re-enqueued with resumeAtSeq rather than redelivered from seq 0. */

const ENV = createEnv({
  BASECAMP_MIN_INTERVAL_MS: '0',
  FETCH_LINE_STATS: 'off',
  RATELIMIT_WAIT_BUDGET_MS: '0',
});

type QueueBatch = Parameters<typeof worker.queue>[0];
type QueueEnv = Parameters<typeof worker.queue>[1];

interface FakeMessage {
  acks: number;
  retries: Array<{ delaySeconds?: number }>;
}

interface SentMessage {
  job: QueuedJob;
  options?: { delaySeconds?: number };
}

function batch(job: PushJob, attempts = 1): { batch: unknown; message: FakeMessage } {
  const message: FakeMessage = { acks: 0, retries: [] };
  return {
    message,
    batch: {
      queue: 'commits',
      messages: [
        {
          id: 'message-1',
          timestamp: new Date(0),
          body: toQueuedJob(job),
          attempts,
          ack: () => void (message.acks += 1),
          retry: (options?: { delaySeconds?: number }) => void message.retries.push(options ?? {}),
        },
      ],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the subrequest budget', () => {
  it('is fresh per invocation, not shared across the cached context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes('/lines.json')) return new Response('{}', { status: 201 });
        return new Response('{}', { status: 200 });
      }),
    );
    const sent: SentMessage[] = [];
    const env = {
      ...ENV,
      SUBREQUEST_BUDGET: '2',
      COMMITS: {
        send: (job: QueuedJob, options?: { delaySeconds?: number }) => void sent.push({ job, options }),
      },
    };
    for (let i = 0; i < 3; i += 1) {
      const job = makeJob({ deliveryId: `budget-${i}`, commits: [commit(`a${i}`), commit(`b${i}`)] });
      const { batch: b, message } = batch(job);
      await worker.queue(b as QueueBatch, env as unknown as QueueEnv);
      expect(message.acks).toBe(1);
    }
    // Six posts over three invocations, each within its own budget of two.
    expect(sent).toHaveLength(0);
  });

  it('defers the rest of the push once the budget is spent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 201 })),
    );
    const sent: SentMessage[] = [];
    const env = {
      ...ENV,
      SUBREQUEST_BUDGET: '1',
      COMMITS: {
        send: (job: QueuedJob, options?: { delaySeconds?: number }) => void sent.push({ job, options }),
      },
    };
    const { batch: b } = batch(makeJob({ deliveryId: 'budget-defer', commits: [commit('x'), commit('y')] }));
    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);
    expect(sent).toHaveLength(1);
    expect(asQueuedPush(sent[0]!.job).resumeAtSeq).toBe(1);
  });
});

describe('the queue handler on a partial deferral', () => {
  it('re-enqueues with resumeAtSeq and deferrals, then acks the original', async () => {
    let basecampCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (!url.includes('/lines.json')) {
          return new Response('{}', { status: 200 });
        }
        const call = basecampCalls;
        basecampCalls += 1;
        if (call === 0) return new Response('{}', { status: 201 });
        return new Response('', { status: 429, headers: { 'retry-after': '9' } });
      }),
    );

    const sent: SentMessage[] = [];
    const env = {
      ...ENV,
      COMMITS: {
        send: (job: QueuedJob, options?: { delaySeconds?: number }) => void sent.push({ job, options }),
      },
    };
    const job = makeJob({
      deliveryId: 'delivery-partial',
      commits: [commit('1'), commit('2'), commit('3')],
    });
    const { batch: b, message } = batch(job);

    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    expect(basecampCalls).toBe(2);
    expect(message.acks).toBe(1);
    expect(message.retries).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(asQueuedPush(sent[0]!.job).resumeAtSeq).toBe(1);
    expect(sent[0]?.job.deferrals).toBe(1);
    expect(sent[0]?.options).toEqual({ delaySeconds: 9 });
  });

  it('clamps delaySeconds to the Queues maximum on send and retry paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes('/lines.json')) {
          return new Response('', { status: 429, headers: { 'retry-after': '100000' } });
        }
        return new Response('{}', { status: 200 });
      }),
    );

    const sent: SentMessage[] = [];
    const envWithQueue = {
      ...ENV,
      RATELIMIT_WAIT_BUDGET_MS: '0',
      BASECAMP_MAX_SLEEP_MS: '86400000',
      COMMITS: {
        send: (job: QueuedJob, options?: { delaySeconds?: number }) => void sent.push({ job, options }),
      },
    };
    const { batch: b } = batch(makeJob({ commits: [commit('a')] }));
    await worker.queue(b as QueueBatch, envWithQueue as unknown as QueueEnv);
    expect(sent[0]?.options?.delaySeconds).toBe(43_200);

    const envNoQueue = { ...ENV, RATELIMIT_WAIT_BUDGET_MS: '0', BASECAMP_MAX_SLEEP_MS: '86400000', COMMITS: undefined };
    const { batch: b2, message: m2 } = batch(makeJob({ deliveryId: 'retry-clamp', commits: [commit('b')] }));
    await worker.queue(b2 as QueueBatch, envNoQueue as unknown as QueueEnv);
    expect(m2.retries[0]?.delaySeconds).toBe(43_200);
  });
});
