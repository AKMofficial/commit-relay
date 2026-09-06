import { describe, expect, it } from 'vitest';
import { consumeJob, isDeferred } from '../src/queue/consumer.ts';
import type { Deps } from '../src/runtime/deps.ts';
import type { PushJob } from '../src/core/types.ts';
import { createMemoryDedup } from '../src/queue/adapters/store-memory.ts';
import type { Dedup } from '../src/relay/dedup.ts';
import {
  configOf,
  createBasecampRecorder,
  createDeps,
  createEnv,
  createFetchRouter,
  createLogRecorder,
  createSleeper,
  type BasecampRecorder,
  type BasecampScript,
  type LogRecorder,
} from './harness.ts';
import { createFakeMetrics, type FakeMetrics } from './fake-metrics.ts';
import { createGitHubMock, type GitHubMock, type GitHubMockOptions } from './mock-github.ts';
import { commit, job, pullRequestJob } from './push-job.ts';

interface Rig {
  deps: Deps;
  dedup: Dedup;
  github: GitHubMock;
  basecamp: BasecampRecorder;
  logs: LogRecorder;
  metrics: FakeMetrics;
  sleeps: number[];
}

function rig(
  over: Record<string, unknown> = {},
  options: { github?: GitHubMockOptions; basecamp?: BasecampScript; sleep?: Deps['sleep'] } = {},
): Rig {
  const config = configOf(createEnv({ FETCH_LINE_STATS: 'on', ...over }));
  const github = createGitHubMock(options.github);
  const basecamp = createBasecampRecorder(options.basecamp);
  const logs = createLogRecorder();
  const sleeper = createSleeper();
  const metrics = createFakeMetrics();
  const deps = createDeps({
    config,
    fetchImpl: createFetchRouter(github, basecamp),
    log: logs.log,
    sleep: options.sleep ?? sleeper.sleep,
    metrics,
  });
  return { deps, dedup: createMemoryDedup(config, metrics, Date.now), github, basecamp, logs, metrics, sleeps: sleeper.ms };
}

/** Three commits whose 40-hex ids are distinct, so the mock can answer each one
 *  separately and the posted order is checkable from the message alone. */
function threeCommitJob(over: Partial<PushJob> = {}): PushJob {
  return job({ commits: [commit('a'), commit('b'), commit('c')], ...over });
}

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);

describe('delivery dedup', () => {
  it('skips a delivery already recorded completed, without posting again', async () => {
    const { deps, dedup, basecamp, logs } = rig();
    dedup.recordDelivery('delivery-1', 'completed');

    const outcome = await consumeJob(threeCommitJob(), deps, { dedup });

    expect(outcome).toEqual({ posted: 0, failed: 0, skipped: 0, dropped: 0 });
    expect(basecamp.calls).toHaveLength(0);
    expect(logs.find('delivery_duplicate_skipped')).toBeDefined();
  });

  it('reprocesses a delivery recorded failed, so a manual Redeliver still works', async () => {
    const { deps, dedup, basecamp } = rig();
    dedup.recordDelivery('delivery-1', 'failed');

    await consumeJob(threeCommitJob(), deps, { dedup });

    expect(basecamp.calls).toHaveLength(3);
    expect(dedup.deliveryOutcome('delivery-1')).toBe('completed');
  });

  it('processes an unknown delivery id and records the outcome', async () => {
    const { deps, dedup, basecamp } = rig();

    await consumeJob(threeCommitJob(), deps, { dedup });

    expect(basecamp.calls).toHaveLength(3);
    expect(dedup.deliveryOutcome('delivery-1')).toBe('completed');
  });

  it('records a delivery that dropped a line as failed, never completed', async () => {
    const { deps, dedup } = rig({ POST_RETRY_BUDGET_MS: '0' }, { basecamp: () => ({ status: 401 }) });

    await consumeJob(job({ commits: [commit('a')] }), deps, { dedup });

    expect(dedup.deliveryOutcome('delivery-1')).toBe('failed');
  });

  it('posts one line for a commit already delivered on another ref', async () => {
    const { deps, dedup, basecamp } = rig();
    const first = threeCommitJob();

    await consumeJob(first, deps, { dedup });
    await consumeJob(
      { ...first, deliveryId: 'delivery-2', ref: 'refs/heads/release', refName: 'release' },
      deps,
      { dedup },
    );

    expect(basecamp.calls).toHaveLength(3);
  });

  it('posts once for a pull request and skips a redelivery with the same delivery id', async () => {
    const { deps, dedup, basecamp } = rig({ FETCH_LINE_STATS: 'off' });
    const pr = pullRequestJob();

    await consumeJob(pr, deps, { dedup });
    await consumeJob(pr, deps, { dedup });

    expect(basecamp.calls).toHaveLength(1);
    expect(dedup.deliveryOutcome('delivery-1')).toBe('completed');
  });
});

describe('enrich then post', () => {
  it('enriches every commit and posts them serially, in seq order', async () => {
    const { deps, dedup, github, basecamp } = rig();

    const outcome = await consumeJob(threeCommitJob(), deps, { dedup });

    expect(outcome).toEqual({ posted: 3, failed: 0, skipped: 0, dropped: 0 });
    expect(github.calls.toSorted()).toEqual([sha('a'), sha('b'), sha('c')]);
    expect(basecamp.maxInFlight).toBe(1);
    expect(basecamp.contents().map((html) => /commit ([abc])/.exec(html)?.[1])).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(basecamp.contents()[0]).toContain('+42 / -7');
  });

  it('renders N/A when the stats call 404s, and still posts in order', async () => {
    const { deps, dedup, basecamp } = rig({}, { github: { failAll: 'not_found' } });

    const outcome = await consumeJob(threeCommitJob(), deps, { dedup });

    expect(outcome).toMatchObject({ posted: 3 });
    for (const html of basecamp.contents()) {
      expect(html).toContain('<strong>Changes&nbsp;</strong></td><td>N/A');
    }
  });

  it('does not stall the poster when the middle job is dropped after enrichment', async () => {
    const { deps, dedup, basecamp, logs } = rig(
      {},
      { github: { mergeShas: [sha('b')] } },
    );
    const base = threeCommitJob();
    const push: PushJob = {
      ...base,
      commits: base.commits.map((c, index) => (index === 1 ? { ...c, mergeCandidate: true } : c)),
      options: { ...base.options, skipMergeCommits: true },
    };

    const outcome = await consumeJob(push, deps, { dedup });

    expect(outcome).toEqual({ posted: 2, failed: 0, skipped: 1, dropped: 0 });
    expect(basecamp.contents().map((html) => /commit ([abc])/.exec(html)?.[1])).toEqual(['a', 'c']);
    expect(logs.all('push_skipped').map((line) => line.fields['reason'])).toEqual(['merge_commit']);
  });

  it('skips a merge hint when stats are unavailable', async () => {
    const { deps, dedup, basecamp, logs } = rig({ FETCH_LINE_STATS: 'off' });
    const base = threeCommitJob();
    const push: PushJob = {
      ...base,
      commits: base.commits.map((c, index) => (index === 1 ? { ...c, mergeCandidate: true } : c)),
      options: { ...base.options, skipMergeCommits: true },
    };

    const outcome = await consumeJob(push, deps, { dedup });

    expect(outcome).toEqual({ posted: 2, failed: 0, skipped: 1, dropped: 0 });
    expect(basecamp.contents().map((html) => /commit ([abc])/.exec(html)?.[1])).toEqual(['a', 'c']);
    expect(logs.all('push_skipped').map((line) => line.fields['reason'])).toEqual(['merge_commit']);
  });

  it('does not skip when stats say one parent even with a merge hint', async () => {
    const { deps, dedup, basecamp } = rig();
    const base = threeCommitJob();
    const push: PushJob = {
      ...base,
      commits: base.commits.map((c, index) => (index === 1 ? { ...c, mergeCandidate: true } : c)),
      options: { ...base.options, skipMergeCommits: true },
    };

    const outcome = await consumeJob(push, deps, { dedup });

    expect(outcome).toEqual({ posted: 3, failed: 0, skipped: 0, dropped: 0 });
    expect(basecamp.calls).toHaveLength(3);
  });
});

describe('outcomes the queue handler acts on', () => {
  it('defers a 429 beyond the wait budget, with the parsed Retry-After', async () => {
    const { deps, dedup, basecamp, metrics } = rig(
      { RATELIMIT_WAIT_BUDGET_MS: '0' },
      { basecamp: () => ({ status: 429, headers: { 'retry-after': '7' } }) },
    );

    const outcome = await consumeJob(threeCommitJob(), deps, { dedup });

    expect(isDeferred(outcome)).toBe(true);
    expect(outcome).toMatchObject({ deferred: true, retryAfterS: 7, resumeAtSeq: 0, status: 429 });
    // Nothing posted, nothing recorded as done: the redelivery reprocesses it.
    expect(basecamp.calls).toHaveLength(1);
    expect(metrics.values.postedTotal).toBe(0);
    expect(dedup.deliveryOutcome('delivery-1')).toBe('failed');
  });

  it('treats a fatal status as terminal, records it, and returns rather than defers', async () => {
    const { deps, dedup, basecamp, metrics, logs } = rig(
      { POST_RETRY_BUDGET_MS: '0' },
      { basecamp: () => ({ status: 404 }) },
    );

    const outcome = await consumeJob(threeCommitJob(), deps, { dedup });

    expect(isDeferred(outcome)).toBe(false);
    expect(outcome).toMatchObject({ posted: 0, failed: 3, dropped: 3 });
    expect(basecamp.calls).toHaveLength(3);
    expect(metrics.values.failedTotal).toBe(3);
    expect(logs.all('message_dropped')).toHaveLength(3);
  });

  it('flips configHealthy on a 401 so a rotated key is not silent', async () => {
    const { deps, dedup, metrics, logs } = rig(
      { POST_RETRY_BUDGET_MS: '0' },
      { basecamp: () => ({ status: 401 }) },
    );

    await consumeJob(job({ commits: [commit('a')] }), deps, { dedup });

    expect(metrics.values.configHealthy).toBe(0);
    expect(logs.find('config_unhealthy')).toBeDefined();
  });

  it('collapses repeated auth failures to one basecamp_terminal per repo', async () => {
    const { deps, dedup, logs } = rig(
      { POST_RETRY_BUDGET_MS: '0' },
      { basecamp: () => ({ status: 401 }) },
    );

    await consumeJob(job({ commits: [commit('a'), commit('b')] }), deps, { dedup });

    expect(logs.all('message_dropped')).toHaveLength(2);
    expect(logs.all('basecamp_terminal')).toHaveLength(1);
    expect(logs.all('config_unhealthy')).toHaveLength(1);
  });

  it('propagates an unexpected exception instead of swallowing it', async () => {
    const boom = new Error('sleep exploded');
    const { deps, dedup } = rig({}, { sleep: () => Promise.reject(boom) });

    await expect(consumeJob(threeCommitJob(), deps, { dedup })).rejects.toBe(boom);
  });

  it('records a deferred pull request as failed so a redelivery reprocesses it', async () => {
    const { deps, dedup, basecamp } = rig(
      { RATELIMIT_WAIT_BUDGET_MS: '0', FETCH_LINE_STATS: 'off' },
      { basecamp: () => ({ status: 429, headers: { 'retry-after': '7' } }) },
    );

    const outcome = await consumeJob(pullRequestJob(), deps, { dedup });

    expect(isDeferred(outcome)).toBe(true);
    expect(basecamp.calls).toHaveLength(1);
    expect(dedup.deliveryOutcome('delivery-1')).toBe('failed');
  });
});

describe('pacing', () => {
  it('sleeps the poster interval between posts and never reads a clock delta', async () => {
    const { deps, dedup, sleeps } = rig({ BASECAMP_MIN_INTERVAL_MS: '250' });

    await consumeJob(threeCommitJob(), deps, { dedup });

    expect(sleeps.filter((ms) => ms === 250)).toHaveLength(3);
  });

  it('sleeps the poster interval once for a pull request and never reads a clock delta', async () => {
    const { deps, dedup, sleeps, basecamp } = rig({
      BASECAMP_MIN_INTERVAL_MS: '250',
      FETCH_LINE_STATS: 'off',
    });

    await consumeJob(pullRequestJob(), deps, { dedup });

    expect(basecamp.calls).toHaveLength(1);
    expect(sleeps.filter((ms) => ms === 250)).toHaveLength(1);
  });
});
