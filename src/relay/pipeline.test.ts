import { describe, expect, it } from 'vitest';
import { relayPullRequest, relayPush } from './pipeline.ts';
import { isDeferred } from './poster.ts';
import { Dedup, commitKey, pullRequestDedupKey, rollupKey, type DeliveryOutcome, type Store } from './dedup.ts';
import { MemoryStore } from '../queue/adapters/store-memory.ts';
import { configObject, type Config } from '../config/schema.ts';
import type { Deps } from '../runtime/deps.ts';
import type { LogLevel } from '../obs/log.ts';
import type { NormalizedCommit, PullRequestJob, PushJob } from '../core/types.ts';
import { createFakeMetrics, type FakeMetrics } from '../../tests/fake-metrics.ts';
import mergeStats from '../../tests/fixtures/commit.stats.merge.json?raw';
import plainStats from '../../tests/fixtures/commit.stats.json?raw';
import { createSubrequestBudget } from '../core/subrequests.ts';
import { pullRequestJob } from '../../tests/push-job.ts';

interface LogLine {
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
}

interface Harness {
  deps: Deps;
  metrics: FakeMetrics;
  logs: LogLine[];
  sleeps: number[];
  basecampBodies: string[];
  githubUrls: string[];
  maxInFlightBasecamp: number;
  maxInFlightGithub: number;
}

interface HarnessOptions {
  config?: Record<string, unknown>;
  basecamp?: (call: number) => Response;
  github?: (url: string, signal: AbortSignal | undefined) => Promise<Response>;
  fireDeadline?: boolean;
}

function makeConfig(over: Record<string, unknown> = {}): Config {
  return configObject.parse({
    GITHUB_WEBHOOK_SECRET: 'pipeline-test-secret-0000000000000000000',
    ...over,
  });
}

function makeCommit(index: number, over: Partial<NormalizedCommit> = {}): NormalizedCommit {
  const id = `${index}`.repeat(40).slice(0, 40);
  return {
    id,
    message: `commit ${index}`,
    url: `https://github.com/your-org/your-repo/commit/${id}`,
    distinct: true,
    authorName: 'Jane Doe',
    authorEmail: 'jane@example.com',
    authorUsername: 'jane-doe',
    fileCount: 2,
    ...over,
  };
}

function makeJob(commits: NormalizedCommit[], over: Partial<PushJob> = {}): PushJob {
  return {
    type: 'push',
    deliveryId: 'delivery-1',
    repoFullName: 'your-org/your-repo',
    ref: 'refs/heads/main',
    refKind: 'branch',
    refName: 'main',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    compareUrl: 'https://github.com/your-org/your-repo/compare/aaa...bbb',
    forced: false,
    created: false,
    commits,
    target: {
      accountId: '1234567',
      chatbotKey: 'chatbot-key',
      bucketId: '2345678',
      chatId: '7654321',
      apiBase: 'https://basecamp.test',
      githubToken: 'gh-token',
      githubApiBase: 'https://api.github.test',
      webOrigin: 'https://github.com',
    },
    options: {
      skipMergeCommits: true,
      skipForcedPushes: false,
      skipNonDistinct: true,
      ignoreAuthors: [],
      maxCommitsPerPush: 15,
      prActions: ['opened', 'closed', 'reopened', 'ready_for_review'],
      prReviews: true,
      prSkipDrafts: true,
    },
    ...over,
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const logs: LogLine[] = [];
  const sleeps: number[] = [];
  const basecampBodies: string[] = [];
  const githubUrls: string[] = [];
  let basecampCalls = 0;
  let inFlightBasecamp = 0;
  let inFlightGithub = 0;

  const harness: Harness = {
    logs,
    sleeps,
    basecampBodies,
    githubUrls,
    maxInFlightBasecamp: 0,
    maxInFlightGithub: 0,
    metrics: createFakeMetrics(),
    deps: undefined as unknown as Deps,
  };

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/lines.json')) {
      inFlightBasecamp += 1;
      harness.maxInFlightBasecamp = Math.max(harness.maxInFlightBasecamp, inFlightBasecamp);
      basecampBodies.push(String(init?.body ?? ''));
      const call = basecampCalls;
      basecampCalls += 1;
      await Promise.resolve();
      inFlightBasecamp -= 1;
      return options.basecamp?.(call) ?? new Response('{}', { status: 201 });
    }
    githubUrls.push(url);
    inFlightGithub += 1;
    harness.maxInFlightGithub = Math.max(harness.maxInFlightGithub, inFlightGithub);
    try {
      const responder = options.github;
      if (responder !== undefined) return await responder(url, init?.signal ?? undefined);
      return new Response(plainStats, { status: 200 });
    } finally {
      inFlightGithub -= 1;
    }
  }) as unknown as typeof fetch;

  let clock = 1_000;
  const config = makeConfig(options.config);

  harness.deps = {
    fetchImpl,
    subrequests: createSubrequestBudget(0),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      if (ms === config.ENRICH_DEADLINE_MS && options.fireDeadline !== true) {
        await new Promise<void>(() => {});
      }
    },
    log: (level, event, fields = {}) => {
      logs.push({ level, event, fields });
    },
    metrics: harness.metrics,
    now: () => {
      clock += 1;
      return clock;
    },
    config,
  };

  return harness;
}

function postedShas(harness: Harness): string[] {
  return harness.logs.filter((line) => line.event === 'message_posted').map((line) => String(line.fields['sha']));
}

describe('relayPush', () => {
  it('posts serially, with no two Basecamp fetches in flight', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off' } });
    const job = makeJob([makeCommit(1), makeCommit(2), makeCommit(3)]);

    const outcome = await relayPush(job, h.deps);

    expect(isDeferred(outcome)).toBe(false);
    expect(outcome).toMatchObject({ posted: 3, failed: 0, skipped: 0, dropped: 0 });
    expect(h.maxInFlightBasecamp).toBe(1);
    expect(postedShas(h)).toEqual(['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]);
  });

  it('advances past a merge commit confirmed after enrichment', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'on', GITHUB_CONCURRENCY: 1 },
      github: (url) =>
        Promise.resolve(new Response(url.includes('/commits/2') ? mergeStats : plainStats, { status: 200 })),
    });
    const job = makeJob([makeCommit(1), makeCommit(2), makeCommit(3)]);

    const outcome = await relayPush(job, h.deps);

    expect(outcome).toMatchObject({ posted: 2, skipped: 1 });
    expect(postedShas(h)).toEqual(['1'.repeat(40), '3'.repeat(40)]);
    const skip = h.logs.find((line) => line.event === 'push_skipped');
    expect(skip?.level).toBe('info');
    expect(skip?.fields['reason']).toBe('merge_commit');
  });

  it('advances past a render failure mid-sequence and drops it with content_unrenderable', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off', CONTENT_MAX_BYTES: 900 } });
    const job = makeJob([
      makeCommit(1),
      makeCommit(2, { authorName: 'A'.repeat(900), authorUsername: null }),
      makeCommit(3),
    ]);

    const outcome = await relayPush(job, h.deps);

    expect(outcome).toMatchObject({ posted: 2, dropped: 1 });
    expect(postedShas(h)).toEqual(['1'.repeat(40), '3'.repeat(40)]);
    const drop = h.logs.find((line) => line.event === 'content_unrenderable');
    expect(drop?.level).toBe('error');
    expect(drop?.fields).toEqual({
      deliveryId: job.deliveryId,
      repo: 'your-org/your-repo',
      sha: '2'.repeat(40),
    });
    expect(h.metrics.values.droppedTotal).toBe(1);
  });

  it('posts exactly one rollup message and makes no GitHub call', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'on' } });
    const job = makeJob([makeCommit(1), makeCommit(2)], {
      rollup: { kind: 'cap', fileCount: 7, authors: ['jane-doe', 'octocat'] },
    });

    const outcome = await relayPush(job, h.deps);

    expect(outcome).toMatchObject({ posted: 1 });
    expect(h.githubUrls).toEqual([]);
    expect(h.basecampBodies).toHaveLength(1);
    const content = JSON.parse(h.basecampBodies[0] ?? '{}') as { content: string };
    expect(content.content).toContain('your-org/your-repo');
    expect(content.content).toContain('main');
    expect(content.content).toContain('>7<');
    expect(content.content).toContain('jane-doe, octocat');
    expect(content.content).toContain('compare/aaa...bbb');
    expect(content.content).toContain('N/A');
    expect(content.content).not.toContain('2 commits');
  });

  it('paces with the pacingMs postLine returned', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off', BASECAMP_MIN_INTERVAL_MS: 321 } });
    const job = makeJob([makeCommit(1), makeCommit(2)]);

    await relayPush(job, h.deps);

    expect(h.sleeps.filter((ms) => ms === 321)).toHaveLength(2);
  });

  it('force-promotes with stats null at the deadline, aborts the controller, and discards the late resolution', async () => {
    let observed: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'on', GITHUB_CONCURRENCY: 1 },
      fireDeadline: true,
      github: async (_url, signal) => {
        observed = signal;
        await gate;
        return new Response(plainStats, { status: 200 });
      },
    });
    const job = makeJob([makeCommit(1)]);

    const running = relayPush(job, h.deps);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    release?.();
    const outcome = await running;

    expect(outcome).toMatchObject({ posted: 1 });
    expect(observed?.aborted).toBe(true);
    expect(h.logs.some((line) => line.event === 'stats_deadline')).toBe(true);
    const content = JSON.parse(h.basecampBodies[0] ?? '{}') as { content: string };
    expect(content.content).toContain('N/A');
    expect(content.content).not.toContain('+42 / -7');
  });

  it('never exceeds GITHUB_CONCURRENCY in flight', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'on', GITHUB_CONCURRENCY: 2 },
      github: async () => {
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
        return new Response(plainStats, { status: 200 });
      },
    });
    const job = makeJob([1, 2, 3, 4, 5, 6].map((n) => makeCommit(n)));

    await relayPush(job, h.deps);

    expect(h.githubUrls).toHaveLength(6);
    expect(h.maxInFlightGithub).toBe(2);
  });

  it('returns the deferred signal on a 429 beyond the in-poster budget', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'off', RATELIMIT_WAIT_BUDGET_MS: 0 },
      basecamp: () => new Response('', { status: 429, headers: { 'retry-after': '5' } }),
    });
    const job = makeJob([makeCommit(1), makeCommit(2)]);

    const outcome = await relayPush(job, h.deps);

    expect(outcome).toEqual({ deferred: true, retryAfterS: 5, resumeAtSeq: 0, status: 429 });
    expect(h.basecampBodies).toHaveLength(1);
    expect(h.metrics.values.postedTotal).toBe(0);
  });

  it('skips seqs before resumeAtSeq and posts only from that point', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'off' },
      basecamp: () => new Response('{}', { status: 201 }),
    });
    const job = makeJob([makeCommit(1), makeCommit(2), makeCommit(3)], { resumeAtSeq: 1 });

    const outcome = await relayPush(job, h.deps);

    expect(isDeferred(outcome)).toBe(false);
    expect(outcome).toMatchObject({ posted: 2, skipped: 1 });
    expect(postedShas(h)).toEqual(['2'.repeat(40), '3'.repeat(40)]);
    expect(h.basecampBodies).toHaveLength(2);
    expect(h.metrics.values.skippedTotal).toBe(0);
    expect(h.logs.some((line) => line.event === 'push_resumed')).toBe(true);
  });

  it('records the failure and flips configHealthy on a fatal 401', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'off' },
      basecamp: () => new Response('', { status: 401 }),
    });
    const job = makeJob([makeCommit(1)]);

    const outcome = await relayPush(job, h.deps);

    expect(outcome).toMatchObject({ posted: 0, failed: 1 });
    expect(h.metrics.values.configHealthy).toBe(0);
    expect(h.metrics.values.failedTotal).toBe(1);
    const dropped = h.logs.find((line) => line.event === 'message_dropped');
    expect(dropped?.fields['lastStatus']).toBe(401);
    expect(h.logs.some((line) => line.event === 'basecamp_terminal')).toBe(true);
    expect(h.logs.some((line) => line.event === 'config_unhealthy')).toBe(true);
  });

  it('skips a commit already posted for the same (repo, sha, bucket, chat)', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off' } });
    const now = (): number => 1_000;
    const deliveries: Store<DeliveryOutcome> = new MemoryStore<DeliveryOutcome>({
      maxEntries: 10,
      ttlMs: 60_000,
    });
    const commits: Store<true> = new MemoryStore<true>({ maxEntries: 10, ttlMs: 60_000 });
    const dedup = new Dedup({ deliveries, commits, now });
    const job = makeJob([makeCommit(1)]);

    const first = await relayPush(job, h.deps, { dedup });
    expect(first).toMatchObject({ posted: 1 });
    expect(dedup.hasCommit(commitKey('your-org/your-repo', '1'.repeat(40), '2345678', '7654321'))).toBe(true);

    const second = await relayPush(job, h.deps, { dedup });
    expect(second).toMatchObject({ posted: 0, skipped: 1 });
    expect(h.basecampBodies).toHaveLength(1);
  });

  it('posts a rollup once and skips a redelivery with rollup_duplicate_skipped', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'on' } });
    const now = (): number => 1_000;
    const dedup = new Dedup({
      deliveries: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      commits: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      now,
    });
    const job = makeJob([makeCommit(1)], {
      rollup: { kind: 'forced', fileCount: 3, authors: ['jane-doe'] },
      forced: true,
    });

    const first = await relayPush(job, h.deps, { dedup });
    expect(first).toMatchObject({ posted: 1 });
    const key = rollupKey(
      job.repoFullName,
      job.ref,
      job.before,
      job.after,
      'forced',
      job.target.bucketId,
      job.target.chatId,
    );
    expect(dedup.hasCommit(key)).toBe(true);

    const second = await relayPush(job, h.deps, { dedup });
    expect(second).toMatchObject({ posted: 0, skipped: 1 });
    expect(h.basecampBodies).toHaveLength(1);
    expect(h.logs.some((l) => l.event === 'rollup_duplicate_skipped')).toBe(true);
  });

  it('does not record a rollup dedup key when the post fails', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'on' },
      basecamp: () => new Response('', { status: 500 }),
    });
    const dedup = new Dedup({
      deliveries: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      commits: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      now: () => 1_000,
    });
    const job = makeJob([], { rollup: { kind: 'branch_create', fileCount: 0, authors: [] }, created: true });

    await relayPush(job, h.deps, { dedup });
    const key = rollupKey(
      job.repoFullName,
      job.ref,
      job.before,
      job.after,
      'branch_create',
      job.target.bucketId,
      job.target.chatId,
    );
    expect(dedup.hasCommit(key)).toBe(false);
  });

  it('posts two different rollup kinds for the same repo', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'on' } });
    const dedup = new Dedup({
      deliveries: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      commits: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      now: () => 1_000,
    });
    const forced = makeJob([makeCommit(1)], {
      rollup: { kind: 'forced', fileCount: 1, authors: ['jane-doe'] },
      forced: true,
    });
    const branchCreate = makeJob([makeCommit(2)], {
      rollup: { kind: 'branch_create', fileCount: 0, authors: [] },
      created: true,
      before: '0'.repeat(40),
      after: '3'.repeat(40),
    });

    await relayPush(forced, h.deps, { dedup });
    await relayPush(branchCreate, h.deps, { dedup });
    expect(h.basecampBodies).toHaveLength(2);
  });
});

describe('relayPullRequest', () => {
  function freshDedup(): Dedup {
    return new Dedup({
      deliveries: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      commits: new MemoryStore({ maxEntries: 10, ttlMs: 60_000 }),
      now: () => 1_000,
    });
  }

  function prKey(job: PullRequestJob): string {
    return pullRequestDedupKey(job, job.target.bucketId, job.target.chatId);
  }

  it('posts exactly one Basecamp line with no GitHub fetch', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'on' } });
    const job = pullRequestJob();

    const outcome = await relayPullRequest(job, h.deps);

    expect(outcome).toEqual({ posted: 1, failed: 0, skipped: 0, dropped: 0 });
    expect(h.githubUrls).toEqual([]);
    expect(h.basecampBodies).toHaveLength(1);
    const content = JSON.parse(h.basecampBodies[0] ?? '{}') as { content: string };
    expect(content.content).toContain('Pull request #42 opened');
    expect(content.content).toContain('feat/login → main');
  });

  it('skips a duplicate delivery, increments skippedTotal, and logs pull_request_duplicate_skipped', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off' } });
    const dedup = freshDedup();
    const job = pullRequestJob();

    await relayPullRequest(job, h.deps, { dedup });
    const second = await relayPullRequest(job, h.deps, { dedup });

    expect(second).toMatchObject({ posted: 0, skipped: 1 });
    expect(h.basecampBodies).toHaveLength(1);
    expect(h.metrics.values.skippedTotal).toBe(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        event: 'pull_request_duplicate_skipped',
        fields: expect.objectContaining({ repo: 'your-org/your-repo', pr: 42, deliveryId: 'delivery-1' }),
      }),
    );
  });

  it('posts twice when the kind changes from opened to merged', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off' } });
    const dedup = freshDedup();

    await relayPullRequest(pullRequestJob({ kind: 'opened' }), h.deps, { dedup });
    await relayPullRequest(pullRequestJob({ kind: 'merged' }), h.deps, { dedup });

    expect(h.basecampBodies).toHaveLength(2);
  });

  it('posts twice when the headSha changes for the same kind', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off' } });
    const dedup = freshDedup();

    await relayPullRequest(pullRequestJob({ headSha: 'a'.repeat(40) }), h.deps, { dedup });
    await relayPullRequest(pullRequestJob({ headSha: 'b'.repeat(40) }), h.deps, { dedup });

    expect(h.basecampBodies).toHaveLength(2);
  });

  it('posts two reviews with different reviewId and once for the same reviewId', async () => {
    const h = createHarness({ config: { FETCH_LINE_STATS: 'off' } });
    const dedup = freshDedup();
    const base = pullRequestJob({ kind: 'review_approved', reviewId: 900001 });

    await relayPullRequest(base, h.deps, { dedup });
    await relayPullRequest({ ...base, reviewId: 900002 }, h.deps, { dedup });
    await relayPullRequest(base, h.deps, { dedup });

    expect(h.basecampBodies).toHaveLength(2);
  });

  it('does not record dedup on a fatal 401 and logs message_dropped with pr and null sha', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'off' },
      basecamp: () => new Response('', { status: 401 }),
    });
    const dedup = freshDedup();
    const job = pullRequestJob();

    const outcome = await relayPullRequest(job, h.deps, { dedup });

    expect(outcome).toMatchObject({ posted: 0, failed: 1 });
    expect(dedup.hasCommit(prKey(job))).toBe(false);
    expect(h.metrics.values.failedTotal).toBe(1);
    expect(h.logs.find((line) => line.event === 'message_dropped')?.fields).toMatchObject({
      pr: 42,
      sha: null,
    });
  });

  it('defers on a 429 beyond the wait budget without recording dedup', async () => {
    const h = createHarness({
      config: { FETCH_LINE_STATS: 'off', RATELIMIT_WAIT_BUDGET_MS: 0 },
      basecamp: () => new Response('', { status: 429, headers: { 'retry-after': '5' } }),
    });
    const dedup = freshDedup();
    const job = pullRequestJob();

    const outcome = await relayPullRequest(job, h.deps, { dedup });

    expect(outcome).toEqual({ deferred: true, retryAfterS: 5, resumeAtSeq: 0, status: 429 });
    expect(dedup.hasCommit(prKey(job))).toBe(false);
  });
});
