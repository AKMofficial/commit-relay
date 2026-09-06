import { describe, expect, it } from 'vitest';
import type { AsyncTier } from './types.ts';
import { queuedJobSchema } from './queued-job-schema.ts';
import { Dedup, commitKey, pullRequestKey, pullRequestReviewKey, type DeliveryOutcome, type Store } from '../relay/dedup.ts';
import { MemoryStore, createMemoryDedup } from './adapters/store-memory.ts';
import { configObject } from '../config/schema.ts';
import { createFakeMetrics } from '../../tests/fake-metrics.ts';
import type { PushJob, RelayJob } from '../core/types.ts';

const cfg = configObject.parse({ GITHUB_WEBHOOK_SECRET: 'queue-types-test-secret-000000000000000' });

function makeDedup(now: () => number, over: { maxEntries?: number; ttlMs?: number } = {}): Dedup {
  const maxEntries = over.maxEntries ?? 100;
  const ttlMs = over.ttlMs ?? 60_000;
  const deliveries: Store<DeliveryOutcome> = new MemoryStore<DeliveryOutcome>({ maxEntries, ttlMs });
  const commits: Store<true> = new MemoryStore<true>({ maxEntries, ttlMs });
  return new Dedup({ deliveries, commits, now });
}

describe('AsyncTier', () => {
  it('is a single-method seam over a whole push job', async () => {
    const seen: RelayJob[] = [];
    const tier: AsyncTier = {
      enqueue(job) {
        seen.push(job);
        return Promise.resolve();
      },
    };
    const job = { deliveryId: 'd1', commits: [] } as unknown as PushJob;

    await tier.enqueue(job);

    expect(Object.keys(tier)).toEqual(['enqueue']);
    expect(seen).toEqual([job]);
  });
});

describe('delivery dedup', () => {
  it('skips a completed delivery and reprocesses a failed or unknown one', () => {
    const dedup = makeDedup(() => 1_000);

    expect(dedup.shouldSkipDelivery('unknown')).toBe(false);

    dedup.recordDelivery('d-failed', 'failed');
    expect(dedup.shouldSkipDelivery('d-failed')).toBe(false);

    dedup.recordDelivery('d-done', 'completed');
    expect(dedup.shouldSkipDelivery('d-done')).toBe(true);
    expect(dedup.deliveryOutcome('d-done')).toBe('completed');
  });

  it('forgets a delivery once the TTL has passed', () => {
    let now = 1_000;
    const dedup = makeDedup(() => now, { ttlMs: 5_000 });
    dedup.recordDelivery('d-done', 'completed');

    now = 6_500;
    expect(dedup.shouldSkipDelivery('d-done')).toBe(false);
  });

  it('evicts the oldest entry rather than growing past the bound', () => {
    const dedup = makeDedup(() => 1_000, { maxEntries: 2 });
    dedup.recordDelivery('a', 'completed');
    dedup.recordDelivery('b', 'completed');
    dedup.recordDelivery('c', 'completed');

    expect(dedup.shouldSkipDelivery('a')).toBe(false);
    expect(dedup.shouldSkipDelivery('b')).toBe(true);
    expect(dedup.shouldSkipDelivery('c')).toBe(true);
    expect(dedup.sizes().deliveries).toBe(2);
  });
});

describe('commit dedup', () => {
  it('keys on repo, sha, bucket and chat', () => {
    const dedup = makeDedup(() => 1_000);
    const key = commitKey('o/r', 'abc', '111', '222');

    expect(key).toBe('o/r|abc|111|222');
    expect(dedup.hasCommit(key)).toBe(false);
    dedup.recordCommit(key);
    expect(dedup.hasCommit(key)).toBe(true);
    expect(dedup.hasCommit(commitKey('o/r', 'abc', '111', '999'))).toBe(false);
  });

  it('namespaces pull request keys away from commit and review keys', () => {
    const prKeyValue = pullRequestKey('o/r', 42, 'opened', 'abc', '111', '222');
    const reviewKey = pullRequestReviewKey('o/r', 900001, '111', '222');
    expect(prKeyValue).not.toBe(commitKey('o/r', 'abc', '111', '222'));
    expect(reviewKey).not.toBe(prKeyValue);
  });

  it('is bounded independently of the delivery map', () => {
    const deliveries: Store<DeliveryOutcome> = new MemoryStore<DeliveryOutcome>({
      maxEntries: 1,
      ttlMs: 60_000,
    });
    const commits: Store<true> = new MemoryStore<true>({ maxEntries: 10, ttlMs: 60_000 });
    const dedup = new Dedup({ deliveries, commits, now: () => 1_000 });

    dedup.recordCommit(commitKey('o/r', 'abc', '1', '2'));
    for (let i = 0; i < 20; i += 1) dedup.recordDelivery(`d${i}`, 'completed');

    expect(dedup.sizes().deliveries).toBe(1);
    expect(dedup.hasCommit(commitKey('o/r', 'abc', '1', '2'))).toBe(true);
  });
});

describe('createMemoryDedup', () => {
  it('reports both map sizes as gauges', () => {
    const metrics = createFakeMetrics();
    const dedup = createMemoryDedup(cfg, metrics, () => 1_000);

    dedup.recordDelivery('d1', 'completed');
    dedup.recordCommit(commitKey('o/r', 'abc', '1', '2'));

    expect(metrics.values.dedupeDeliveries).toBe(1);
    expect(metrics.values.dedupeCommits).toBe(1);
  });

  it('bounds a store by bytes as well as by entries', () => {
    const store = new MemoryStore<true>({ maxEntries: 1_000, ttlMs: 60_000, maxBytes: 200 });
    for (let i = 0; i < 20; i += 1) store.set(`key-${i}`, true, 1_000);

    expect(store.byteSize()).toBeLessThanOrEqual(200);
    expect(store.size()).toBeLessThan(20);
  });
});

describe('queuedJobSchema', () => {
  it('rejects a deliveryId longer than 64 characters', () => {
    const base = {
      deliveryId: 'd'.repeat(64),
      repoFullName: 'your-org/your-repo',
      ref: 'refs/heads/main',
      refKind: 'branch' as const,
      refName: 'main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      compareUrl: 'https://github.com/your-org/your-repo/compare/a...b',
      forced: false,
      created: false,
      commits: [],
    };
    expect(queuedJobSchema.safeParse(base).success).toBe(true);
    expect(queuedJobSchema.safeParse({ ...base, deliveryId: 'd'.repeat(65) }).success).toBe(false);
  });
});
