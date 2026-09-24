import { describe, expect, it } from 'vitest';
import { queuedJobSchema } from './queued-job-schema.ts';

const push = {
  deliveryId: 'd-1',
  repoFullName: 'your-org/your-repo',
  refKind: 'branch',
  refName: 'main',
  type: 'push',
  ref: 'refs/heads/main',
  before: '0'.repeat(40),
  after: '1'.repeat(40),
  compareUrl: 'https://example.com/compare',
  forced: false,
  created: false,
  commits: [],
};

const pullRequest = {
  deliveryId: 'd-2',
  repoFullName: 'your-org/your-repo',
  refKind: 'branch',
  refName: 'feature',
  type: 'pull_request',
  kind: 'opened',
  number: 7,
  title: 'Add thing',
  htmlUrl: 'https://example.com/pull/7',
  headRef: 'feature',
  headSha: '2'.repeat(40),
  author: 'octocat',
  fileCount: 3,
  additions: 10,
  deletions: 0,
  reviewId: 42,
};

describe('queuedJobSchema bounds', () => {
  it('accepts non-negative integer counters', () => {
    expect(queuedJobSchema.safeParse({ ...push, deferrals: 2, resumeAtSeq: 0 }).success).toBe(true);
  });

  it('rejects negative or fractional counters', () => {
    expect(queuedJobSchema.safeParse({ ...push, deferrals: -1e9 }).success).toBe(false);
    expect(queuedJobSchema.safeParse({ ...push, deferrals: 1.5 }).success).toBe(false);
    expect(queuedJobSchema.safeParse({ ...push, resumeAtSeq: -1 }).success).toBe(false);
  });

  it('rejects a resumeAtSeq past the commit count', () => {
    expect(queuedJobSchema.safeParse({ ...push, resumeAtSeq: 1 }).success).toBe(false);
    expect(queuedJobSchema.safeParse({ ...push, resumeAtSeq: 1e6 }).success).toBe(false);
  });

  it('bounds pull request counters and ids', () => {
    expect(queuedJobSchema.safeParse(pullRequest).success).toBe(true);
    expect(queuedJobSchema.safeParse({ ...pullRequest, number: 0 }).success).toBe(false);
    expect(queuedJobSchema.safeParse({ ...pullRequest, additions: -1 }).success).toBe(false);
    expect(queuedJobSchema.safeParse({ ...pullRequest, reviewId: 1.5 }).success).toBe(false);
  });
});
