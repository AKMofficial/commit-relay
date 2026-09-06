import { describe, expect, it } from 'vitest';
import { CfQueueTier, capOversizeJob } from '../src/queue/adapters/cf-queue.ts';
import { MemoryFifoTier } from '../src/queue/adapters/memory-fifo.ts';
import { WaitUntilTier } from '../src/queue/adapters/cf-waituntil.ts';
import { consumeJob } from '../src/queue/consumer.ts';
import { Dedup } from '../src/relay/dedup.ts';
import { MemoryStore } from '../src/queue/adapters/store-memory.ts';
import { queuedJobSchema } from '../src/queue/queued-job-schema.ts';
import type { Deps } from '../src/runtime/deps.ts';
import type { LogFn } from '../src/obs/log.ts';
import type { NormalizedCommit, QueuedJob, RelayResult } from '../src/core/types.ts';
import { toQueuedJob } from '../src/core/types.ts';
import { createFakeMetrics } from './fake-metrics.ts';
import { job as makeJob, commit, asPush, asQueuedPush, asQueuedPullRequest, pullRequestJob } from './push-job.ts';
import { createSubrequestBudget } from '../src/core/subrequests.ts';

interface Line {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function depsWith(lines: Line[]): Deps {
  const log: LogFn = (level, event, fields) => void lines.push({ level, event, fields });
  return {
    fetchImpl: () => Promise.reject(new Error('no fetch in this test')),
    sleep: () => Promise.resolve(),
    log,
    metrics: createFakeMetrics(),
    now: () => 1_700_000_000_000,
    // Nothing in these three tiers reads the config; the pipeline does.
    config: {} as Deps['config'],
    subrequests: createSubrequestBudget(0),
  };
}

function dedup(now = () => 0): Dedup {
  return new Dedup({
    deliveries: new MemoryStore({ maxEntries: 10, ttlMs: 1000 }),
    commits: new MemoryStore({ maxEntries: 10, ttlMs: 1000 }),
    now,
  });
}

describe('capOversizeJob', () => {
  it('passes a job under the ceiling through untouched', () => {
    const original = makeJob({ commits: [commit('a'), commit('b')] });
    const sized = capOversizeJob(original);
    expect(sized.oversize).toBe(false);
    expect(sized.job).toBe(original);
    expect(sized.bytes).toBeGreaterThan(0);
  });

  it('collapses an over-ceiling job to the cap rollup with distinct authors', () => {
    const commits: NormalizedCommit[] = [
      { ...commit('a'), authorUsername: 'octocat', message: 'x'.repeat(400) },
      { ...commit('b'), authorUsername: 'octocat', message: 'y'.repeat(400) },
      { ...commit('c'), authorUsername: null, authorName: 'Ada', message: 'z'.repeat(400) },
    ];
    const sized = capOversizeJob(makeJob({ commits }), 512);
    expect(sized.oversize).toBe(true);
    expect(asPush(sized.job).commits).toEqual([]);
    expect(asPush(sized.job).rollup).toEqual({ kind: 'cap', fileCount: null, authors: ['octocat', 'Ada'] });
  });

  it('preserves changedPathCount as fileCount when collapsing a per-commit job', () => {
    const commits: NormalizedCommit[] = [
      { ...commit('a'), message: 'x'.repeat(400) },
      { ...commit('b'), message: 'y'.repeat(400) },
    ];
    const sized = capOversizeJob(makeJob({ commits, changedPathCount: 12 }), 512);
    expect(sized.oversize).toBe(true);
    expect(asPush(sized.job).rollup?.fileCount).toBe(12);
    expect(asPush(sized.job).rollup).toBeDefined();
    expect(asPush(sized.job).changedPathCount).toBe(12);
  });

  it('round-trips changedPathCount through toQueuedJob and queuedJobSchema', () => {
    const queued = toQueuedJob(makeJob({ changedPathCount: 7 }));
    expect(queuedJobSchema.safeParse(queued).success).toBe(true);
    expect(asQueuedPush(queuedJobSchema.parse(queued)).changedPathCount).toBe(7);
  });

  it('does not treat a per-commit job with changedPathCount as a rollup', () => {
    const original = makeJob({ changedPathCount: 5 });
    expect(original.rollup).toBeUndefined();
    const sized = capOversizeJob(original);
    expect(sized.oversize).toBe(false);
    expect(asPush(sized.job).rollup).toBeUndefined();
  });

  it('drops the title of an oversize pull request job and flags it, never collapsing to a rollup', () => {
    // 4 KiB holds the fixed fields with room to spare; the 8 KB title alone does not fit.
    const padded = pullRequestJob({ title: 'x'.repeat(8_000) });
    const sized = capOversizeJob(padded, 4_096);
    expect(sized.oversize).toBe(true);
    expect(sized.job).toEqual({ ...padded, title: '' });
    expect(capOversizeJob(sized.job, 4_096).oversize).toBe(false);
    expect(sized.bytes).toBeLessThan(4_096);
  });
});

describe('CfQueueTier', () => {
  it('sends one message per push without secrets and warns only when it had to collapse one', async () => {
    const lines: Line[] = [];
    const sent: QueuedJob[] = [];
    const queue = {
      send: (job: QueuedJob) => {
        sent.push(job);
        return Promise.resolve();
      },
    };
    const tier = new CfQueueTier(queue as never, depsWith(lines), 2_000);

    await tier.enqueue(makeJob({ commits: [commit('a')] }));
    expect(lines.filter((l) => l.event === 'queue_message_oversize')).toHaveLength(0);
    expect(sent[0]).not.toHaveProperty('target');
    expect(sent[0]).not.toHaveProperty('options');
    expect(JSON.stringify(sent[0])).not.toContain('test-chatbot-key');

    await tier.enqueue(makeJob({ commits: [commit('b', { message: 'q'.repeat(8_000) })] }));
    const warned = lines.filter((l) => l.event === 'queue_message_oversize');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe('warn');
    expect(sent).toHaveLength(2);
    expect(asQueuedPush(sent[1]!).rollup?.kind).toBe('cap');
  });

  it('sends an oversize pull request without its title, and drops one whose fixed fields alone are over the ceiling', async () => {
    const lines: Line[] = [];
    const sent: QueuedJob[] = [];
    const queue = {
      send: (job: QueuedJob) => {
        sent.push(job);
        return Promise.resolve();
      },
    };

    // 4 KiB: the fixed fields fit, the 8 KB title does not.
    const roomy = new CfQueueTier(queue as never, depsWith(lines), 4_096);
    await roomy.enqueue(pullRequestJob({ title: 'x'.repeat(8_000) }));
    expect(sent).toHaveLength(1);
    expect(asQueuedPullRequest(sent[0]!).title).toBe('');
    expect(lines.filter((l) => l.event === 'queue_message_oversize')).toHaveLength(1);
    expect(lines.filter((l) => l.event === 'message_dropped')).toHaveLength(0);

    // 256 bytes: nothing fits, so the job is dropped loudly rather than thrown at the queue.
    const tight = new CfQueueTier(queue as never, depsWith(lines), 256);
    await tight.enqueue(pullRequestJob({ deliveryId: 'unsendable' }));
    expect(sent).toHaveLength(1);
    expect(lines.find((l) => l.event === 'message_dropped')?.fields).toMatchObject({
      deliveryId: 'unsendable',
      pr: 42,
      sha: null,
      reason: 'queue_message_unsendable',
    });
  });
});

const NOTHING_POSTED: RelayResult = { posted: 0, failed: 0, skipped: 0, dropped: 0 };

describe('WaitUntilTier', () => {
  it('hands the job to waitUntil, one call per push', async () => {
    const lines: Line[] = [];
    const pending: Array<Promise<unknown>> = [];
    const consumed: string[] = [];
    const tier = new WaitUntilTier(
      { waitUntil: (p) => void pending.push(p) },
      (job) => {
        consumed.push(job.deliveryId);
        return Promise.resolve(NOTHING_POSTED);
      },
      depsWith(lines),
    );

    await tier.enqueue(makeJob({ deliveryId: 'one' }));
    await tier.enqueue(makeJob({ deliveryId: 'two' }));
    await Promise.all(pending);

    expect(consumed).toEqual(['one', 'two']);
    expect(pending).toHaveLength(2);
  });

  it('drops a deferred job with message_dropped: this tier has no re-head', async () => {
    const lines: Line[] = [];
    const pending: Array<Promise<unknown>> = [];
    const deps = depsWith(lines);
    const tier = new WaitUntilTier(
      { waitUntil: (p) => void pending.push(p) },
      () => Promise.resolve({ deferred: true as const, retryAfterS: 12, resumeAtSeq: 1, status: 429 }),
      deps,
    );

    await tier.enqueue(makeJob({ commits: [commit('a'), commit('b')] }));
    await Promise.all(pending);

    const dropped = lines.filter((l) => l.event === 'message_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe('error');
    expect(dropped[0]?.fields).toMatchObject({
      deliveryId: 'delivery-1',
      sha: 'b'.repeat(40),
      lastStatus: 429,
      retryAfterS: 12,
    });
    expect(deps.metrics.snapshot().droppedTotal).toBe(1);
  });

  it('logs consumer_exception instead of letting the rejection escape waitUntil', async () => {
    const lines: Line[] = [];
    const pending: Array<Promise<unknown>> = [];
    const tier = new WaitUntilTier(
      { waitUntil: (p) => void pending.push(p) },
      () => Promise.reject(new Error('boom')),
      depsWith(lines),
    );
    await tier.enqueue(makeJob({}));
    await Promise.all(pending);
    expect(lines.some((l) => l.event === 'consumer_exception' && l.level === 'error')).toBe(true);
  });

  it('drops with message_dropped when consume exceeds the waitUntil deadline', async () => {
    const lines: Line[] = [];
    const pending: Array<Promise<unknown>> = [];
    let slept = 0;
    const deps = depsWith(lines);
    const originalSleep = deps.sleep;
    deps.sleep = async (ms: number) => {
      if (ms === 25_000) slept += 1;
      return originalSleep(ms);
    };
    const tier = new WaitUntilTier(
      { waitUntil: (p) => void pending.push(p) },
      () => new Promise(() => {}),
      deps,
    );
    await tier.enqueue(makeJob({ deliveryId: 'wait-until-timeout' }));
    await Promise.all(pending);
    expect(slept).toBe(1);
    const dropped = lines.filter((l) => l.event === 'message_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.fields).toMatchObject({ tier: 'waitUntil', deadline: true });
  });

  it('drops a pull request job that exceeds the waitUntil deadline with pr and null sha', async () => {
    const lines: Line[] = [];
    const pending: Array<Promise<unknown>> = [];
    const deps = depsWith(lines);
    const tier = new WaitUntilTier(
      { waitUntil: (p) => void pending.push(p) },
      () => new Promise(() => {}),
      deps,
    );
    await tier.enqueue(pullRequestJob({ deliveryId: 'wait-until-pr' }));
    await Promise.all(pending);
    const dropped = lines.find((l) => l.event === 'message_dropped');
    expect(dropped?.fields).toMatchObject({ pr: 42, sha: null, deadline: true });
  });
});

describe('consumeJob delivery dedup', () => {
  it('skips a delivery recorded completed and reprocesses one recorded failed', async () => {
    const lines: Line[] = [];
    const deps = depsWith(lines);
    const store = dedup();
    store.recordDelivery('done', 'completed');
    store.recordDelivery('half', 'failed');

    const skipped = await consumeJob(makeJob({ deliveryId: 'done' }), deps, { dedup: store });
    expect(skipped).toEqual({ posted: 0, failed: 0, skipped: 0, dropped: 0 });
    expect(lines.some((l) => l.event === 'delivery_duplicate_skipped')).toBe(true);

    // No commits, so the pipeline runs to completion without an outbound call.
    const reprocessed = await consumeJob(
      makeJob({ deliveryId: 'half', commits: [] }),
      deps,
      { dedup: store },
    );
    expect(reprocessed).toEqual({ posted: 0, failed: 0, skipped: 0, dropped: 0 });
    expect(store.deliveryOutcome('half')).toBe('completed');
  });
});

describe('MemoryFifoTier pull request drain', () => {
  it('reports jobs but not shas when a pull request is still queued after drain', async () => {
    const lines: Line[] = [];
    const deps = depsWith(lines);
    const tier = new MemoryFifoTier({
      deps,
      maxDepth: 10,
      maxBytes: 10_000_000,
      run: () =>
        Promise.resolve({ deferred: true as const, retryAfterS: 60, resumeAtSeq: 0, status: 429 }),
    });
    await tier.enqueue(pullRequestJob({ deliveryId: 'pr-drain' }));
    const report = await tier.drain(100);
    expect(report).toMatchObject({ jobs: 1, remaining: [] });
  });
});

describe('the queued job wire schema', () => {
  it('accepts a message written before pull request support, as a push', () => {
    // A rolling deploy leaves in-flight messages with no `type` field. A
    // discriminated union reads the raw key, so this is the one case a
    // `.default()` on the discriminant would not have covered.
    const { type, ...legacy } = toQueuedJob(makeJob());
    void type;
    const parsed = queuedJobSchema.safeParse(legacy);
    if (!parsed.success) throw new Error('expected legacy message to parse');
    expect(asQueuedPush(parsed.data).type).toBe('push');
  });

  it('round-trips a pull request job', () => {
    const job = pullRequestJob({ kind: 'merged' });
    const queued = toQueuedJob(job);
    // `target` and `options` are rebuilt by the consumer, never sent.
    expect('target' in queued).toBe(false);
    const parsed = queuedJobSchema.safeParse(queued);
    if (!parsed.success) throw new Error('expected pull request message to parse');
    expect(asQueuedPullRequest(parsed.data).kind).toBe('merged');
  });

  it('rejects a pull request message with an unknown kind or missing headSha', () => {
    const base = asQueuedPullRequest(toQueuedJob(pullRequestJob()));
    expect(queuedJobSchema.safeParse({ ...base, kind: 'review_commented' }).success).toBe(false);
    const { headSha, ...missingSha } = base;
    void headSha;
    expect(queuedJobSchema.safeParse(missingSha).success).toBe(false);
  });
});
