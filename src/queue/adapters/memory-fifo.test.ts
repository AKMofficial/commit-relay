import { describe, expect, it } from 'vitest';
import type { Deps } from '../../runtime/deps.ts';
import type { LogFn } from '../../obs/log.ts';
import type { PostOutcome } from '../../relay/poster.ts';
import { MemoryFifoTier, type RunMode } from './memory-fifo.ts';
import { isQueueFullError } from '../types.ts';
import { createFakeMetrics } from '../../../tests/fake-metrics.ts';
import { job as makeJob, commit, asPush } from '../../../tests/push-job.ts';
import { createSubrequestBudget } from '../../core/subrequests.ts';

interface Line {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function testDeps(lines: Line[] = []): Deps {
  const log: LogFn = (level, event, fields) => void lines.push({ level, event, fields });
  return {
    fetchImpl: () => Promise.reject(new Error('no fetch in this test')),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    metrics: createFakeMetrics(),
    now: Date.now,
    config: {} as Deps['config'],
    subrequests: createSubrequestBudget(0),
  };
}

const done = (posted: number): PostOutcome => ({ posted, failed: 0, skipped: 0, dropped: 0 });

async function settle(tier: MemoryFifoTier): Promise<void> {
  for (let i = 0; i < 500 && tier.depth() > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('MemoryFifoTier', () => {
  it('posts serially in FIFO order, one job at a time', async () => {
    const order: string[] = [];
    let inFlight = 0;
    const tier = new MemoryFifoTier({
      deps: testDeps(),
      maxDepth: 10,
      maxBytes: 10_000_000,
      run: async (job) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(job.deliveryId);
        inFlight -= 1;
        return done(1);
      },
    });

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    await tier.enqueue(makeJob({ deliveryId: 'two' }));
    await tier.enqueue(makeJob({ deliveryId: 'three' }));
    await tier.drain(5_000);

    expect(order).toEqual(['one', 'two', 'three']);
  });

  it('refuses the whole push with a QueueFullError at MAX_QUEUE_DEPTH', async () => {
    const tier = new MemoryFifoTier({
      deps: testDeps(),
      maxDepth: 2,
      maxBytes: 10_000_000,
      run: () => new Promise<PostOutcome>(() => {}),
    });

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    await tier.enqueue(makeJob({ deliveryId: 'two' }));
    const error = await tier.enqueue(makeJob({ deliveryId: 'three' })).catch((e: unknown) => e);

    expect(isQueueFullError(error)).toBe(true);
    expect(isQueueFullError(error) && error.reason).toBe('depth');
    expect(tier.depth()).toBe(2);
  });

  it('refuses on MAX_QUEUE_BYTES before MAX_QUEUE_DEPTH is reached', async () => {
    const tier = new MemoryFifoTier({
      deps: testDeps(),
      maxDepth: 1_000,
      maxBytes: 1_200,
      run: () => new Promise<PostOutcome>(() => {}),
    });

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    const error = await tier
      .enqueue(makeJob({ deliveryId: 'two', commits: [commit('b', { message: 'x'.repeat(4_000) })] }))
      .catch((e: unknown) => e);

    expect(isQueueFullError(error) && error.reason).toBe('bytes');
    expect(tier.depth()).toBe(1);
  });

  it('drains what it can and names the shas it could not', async () => {
    const modes: RunMode[] = [];
    const tier = new MemoryFifoTier({
      deps: testDeps(),
      maxDepth: 10,
      maxBytes: 10_000_000,
      run: async (job, mode) => {
        modes.push(mode);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return done(asPush(job).commits.length);
      },
    });

    await tier.enqueue(makeJob({ deliveryId: 'one', commits: [commit('a')] }));
    await tier.enqueue(makeJob({ deliveryId: 'two', commits: [commit('b')] }));
    await tier.enqueue(makeJob({ deliveryId: 'three', commits: [commit('c')] }));

    const report = await tier.drain(30);
    expect(report.posted).toBe(1);
    expect(report.jobs).toBe(2);
    expect(report.remaining).toEqual([commit('b').id, commit('c').id]);
    expect(modes[0]).toBe('drain');
  });

  it('reports a clean drain when the queue empties inside the deadline', async () => {
    const tier = new MemoryFifoTier({
      deps: testDeps(),
      maxDepth: 10,
      maxBytes: 10_000_000,
      run: () => Promise.resolve(done(1)),
    });

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    await tier.enqueue(makeJob({ deliveryId: 'two' }));
    const report = await tier.drain(2_000);

    expect(report).toMatchObject({ posted: 2, dropped: 0, jobs: 0 });
    expect(report.remaining).toEqual([]);
  });

  it('refuses new work once draining, so intake stops at the first act', async () => {
    const tier = new MemoryFifoTier({
      deps: testDeps(),
      maxDepth: 10,
      maxBytes: 10_000_000,
      run: () => Promise.resolve(done(1)),
    });
    const drained = tier.drain(1_000);
    const error = await tier.enqueue(makeJob({})).catch((e: unknown) => e);
    await drained;
    expect(isQueueFullError(error) && error.reason).toBe('draining');
  });

  it('drops a job whose run threw, at-most-once, and logs consumer_exception', async () => {
    const lines: Line[] = [];
    const seen: string[] = [];
    const tier = new MemoryFifoTier({
      deps: testDeps(lines),
      maxDepth: 10,
      maxBytes: 10_000_000,
      run: (job) => {
        seen.push(job.deliveryId);
        if (job.deliveryId === 'one') return Promise.reject(new Error('boom'));
        return Promise.resolve(done(1));
      },
    });

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    await tier.enqueue(makeJob({ deliveryId: 'two' }));
    const report = await tier.drain(2_000);

    expect(seen).toEqual(['one', 'two']);
    expect(report.dropped).toBe(1);
    expect(lines.some((l) => l.event === 'consumer_exception' && l.level === 'error')).toBe(true);
  });

  it('re-heads a deferred job at the Retry-After and then posts it', async () => {
    const slept: number[] = [];
    const deps = testDeps();
    let attempt = 0;
    const tier = new MemoryFifoTier({
      deps: {
        ...deps,
        sleep: (ms) => {
          slept.push(ms);
          return deps.sleep(0);
        },
      },
      maxDepth: 10,
      maxBytes: 10_000_000,
      run: () => {
        attempt += 1;
        return Promise.resolve(
          attempt === 1 ? { deferred: true, retryAfterS: 3, resumeAtSeq: 0, status: 429 } : done(1),
        );
      },
    });

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    await settle(tier);

    expect(attempt).toBe(2);
    expect(slept).toContain(3_000);
    expect(tier.depth()).toBe(0);
  });

  it('drops a job that keeps deferring, so the head cannot pin the FIFO', async () => {
    const lines: Line[] = [];
    const deps = testDeps(lines);
    const seen: string[] = [];
    const tier = new MemoryFifoTier({
      deps: { ...deps, sleep: () => deps.sleep(0) },
      maxDepth: 10,
      maxBytes: 10_000_000,
      rateLimitBudgetMs: 20_000,
      maxAttempts: 5,
      run: (job) => {
        seen.push(job.deliveryId);
        if (job.deliveryId === 'one') {
          return Promise.resolve({ deferred: true as const, retryAfterS: 1, resumeAtSeq: 0, status: 429 });
        }
        return Promise.resolve(done(1));
      },
    });

    await tier.enqueue(makeJob({ deliveryId: 'one', commits: [commit('a')] }));
    await tier.enqueue(makeJob({ deliveryId: 'two', commits: [commit('b')] }));
    await settle(tier);

    expect(seen.filter((id) => id === 'one')).toHaveLength(5);
    expect(tier.depth()).toBe(0);
    const dropped = lines.find((l) => l.event === 'message_dropped');
    expect(dropped?.level).toBe('error');
    expect(dropped?.fields).toMatchObject({
      deliveryId: 'one',
      repo: 'your-org/your-repo',
      sha: commit('a').id,
      lastStatus: 429,
    });
    expect(seen.at(-1)).toBe('two');
  });

  it('drops on the cumulative retry budget before the attempt ceiling', async () => {
    const lines: Line[] = [];
    const deps = testDeps(lines);
    let attempt = 0;
    const tier = new MemoryFifoTier({
      deps: { ...deps, sleep: () => deps.sleep(0) },
      maxDepth: 10,
      maxBytes: 10_000_000,
      rateLimitBudgetMs: 5_000,
      maxAttempts: 5,
      run: () => {
        attempt += 1;
        return Promise.resolve({ deferred: true as const, retryAfterS: 4, resumeAtSeq: 0, status: 429 });
      },
    });

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    await settle(tier);

    expect(attempt).toBe(2);
    expect(tier.depth()).toBe(0);
    expect(lines.some((l) => l.event === 'message_dropped')).toBe(true);
  });
});
