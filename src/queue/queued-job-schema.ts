import { z } from 'zod';
import { PULL_REQUEST_KINDS, ROLLUP_KINDS } from '../core/types.ts';

const normalizedCommit = z.object({
  id: z.string(),
  message: z.string(),
  url: z.string(),
  distinct: z.boolean(),
  authorName: z.string(),
  authorEmail: z.string(),
  authorUsername: z.string().nullable(),
  fileCount: z.number(),
  mergeCandidate: z.boolean().optional(),
});

/** Shared by both members, so a field can never drift between them. */
const jobBase = {
  deliveryId: z.string().max(64),
  repoFullName: z.string(),
  refKind: z.enum(['branch', 'tag']),
  refName: z.string(),
  deferrals: z.number().optional(),
};

const pushJob = z.object({
  ...jobBase,
  type: z.literal('push'),
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  compareUrl: z.string(),
  forced: z.boolean(),
  created: z.boolean(),
  commits: z.array(normalizedCommit),
  changedPathCount: z.number().nullable().optional(),
  rollup: z
    .object({
      kind: z.enum(ROLLUP_KINDS),
      fileCount: z.number().nullable(),
      authors: z.array(z.string()),
    })
    .optional(),
  resumeAtSeq: z.number().optional(),
});

const pullRequestJob = z.object({
  ...jobBase,
  type: z.literal('pull_request'),
  kind: z.enum(PULL_REQUEST_KINDS),
  number: z.number(),
  title: z.string(),
  htmlUrl: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  author: z.string(),
  fileCount: z.number().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  reviewId: z.number().optional(),
});

/**
 * A message written before pull request support carries no `type`, and a
 * discriminated union reads the raw key, so a `.default()` on the discriminant
 * would not see it. One preprocess covers the rolling-deploy window; it can be
 * deleted a release after every queue in flight has drained.
 */
export const queuedJobSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !('type' in value)
      ? { ...value, type: 'push' }
      : value,
  z.discriminatedUnion('type', [pushJob, pullRequestJob]),
);
