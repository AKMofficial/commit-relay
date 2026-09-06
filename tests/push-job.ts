import type { NormalizedCommit, PullRequestJob, PushJob, QueuedJob, RelayJob } from '../src/core/types.ts';
import { toQueuedJob } from '../src/core/types.ts';

/** A minimal, valid PushJob for the queue suites, so no test has to spell out
 *  the resolved target and the route options it never asserts on. */
export function commit(seed: string, over: Partial<NormalizedCommit> = {}): NormalizedCommit {
  return {
    id: seed.repeat(40).slice(0, 40),
    message: `commit ${seed}`,
    url: `https://github.com/your-org/your-repo/commit/${seed}`,
    distinct: true,
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    authorUsername: 'ada',
    fileCount: 1,
    ...over,
  };
}

export function job(over: Partial<PushJob> = {}): PushJob {
  return {
    type: 'push',
    deliveryId: 'delivery-1',
    repoFullName: 'your-org/your-repo',
    ref: 'refs/heads/main',
    refKind: 'branch',
    refName: 'main',
    before: '1'.repeat(40),
    after: '2'.repeat(40),
    compareUrl: 'https://github.com/your-org/your-repo/compare/1111111...2222222',
    forced: false,
    created: false,
    commits: [commit('a')],
    target: {
      accountId: '1234567',
      chatbotKey: 'test-chatbot-key',
      bucketId: '2345678',
      chatId: '7654321',
      apiBase: 'https://3.basecampapi.com',
      githubToken: null,
      githubApiBase: 'https://api.github.com',
      webOrigin: 'https://github.com',
    },
    options: {
      skipMergeCommits: false,
      skipForcedPushes: false,
      skipNonDistinct: false,
      ignoreAuthors: [],
      maxCommitsPerPush: 15,
      prActions: ['opened', 'closed', 'reopened', 'ready_for_review'],
      prReviews: true,
      prSkipDrafts: true,
    },
    ...over,
  };
}

export function queuedJob(over: Partial<PushJob> = {}): QueuedJob {
  return toQueuedJob(job(over));
}

/** A minimal, valid PullRequestJob for the queue suites. */
export function pullRequestJob(over: Partial<PullRequestJob> = {}): PullRequestJob {
  return {
    type: 'pull_request',
    kind: 'opened',
    deliveryId: 'delivery-1',
    repoFullName: 'your-org/your-repo',
    refKind: 'branch',
    refName: 'main',
    number: 42,
    title: 'Add OAuth login flow',
    htmlUrl: 'https://github.com/your-org/your-repo/pull/42',
    headRef: 'feat/login',
    headSha: 'a'.repeat(40),
    author: 'jane-doe',
    fileCount: 7,
    additions: 180,
    deletions: 24,
    target: job().target,
    options: job().options,
    ...over,
  };
}

/** The queue seam carries either job type; a push suite asserting on commits or
 *  a rollup narrows back through here rather than casting. */
export function asPush(job: RelayJob): PushJob {
  if (job.type !== 'push') throw new Error(`expected a push job, got ${job.type}`);
  return job;
}

export function asQueuedPush(job: QueuedJob): Omit<PushJob, 'target' | 'options'> {
  if (job.type !== 'push') throw new Error(`expected a push job, got ${job.type}`);
  return job;
}

export function asQueuedPullRequest(job: QueuedJob): Omit<PullRequestJob, 'target' | 'options'> {
  if (job.type !== 'pull_request') throw new Error(`expected a pull request job, got ${job.type}`);
  return job;
}
