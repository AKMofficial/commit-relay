/** Lenient by design (9.4): a strict payload schema would 422 every self-hosted
 *  install simultaneously the day GitHub adds a field. */

import { z } from 'zod';

/** GitHub's documented push cap; enforced as a hard schema limit (9.4). */
export const COMMITS_ARRAY_CAP = 2048;

const commitAuthor = z.object({
  name: z.string(),
  email: z.string(),
  /** Observed both absent and explicitly null. */
  username: z.string().nullish(),
});

const commit = z.object({
  id: z.string(),
  message: z.string(),
  url: z.string(),
  distinct: z.boolean(),
  author: commitAuthor,
  added: z.array(z.string()).max(10_000),
  removed: z.array(z.string()).max(10_000),
  modified: z.array(z.string()).max(10_000),
});

const repository = z.object({
  full_name: z.string(),
  name: z.string(),
  html_url: z.string(),
  owner: z.object({ login: z.string() }),
});

const sender = z.object({ login: z.string(), type: z.string() });

export const pushPayload = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  created: z.boolean(),
  deleted: z.boolean(),
  forced: z.boolean(),
  compare: z.string(),
  repository,
  sender,
  // Hard limit at 2048 entries; the warning at exactly 2048 stays in parse.ts.
  commits: z.array(commit).max(COMMITS_ARRAY_CAP),
});

export type PushPayload = z.infer<typeof pushPayload>;

/** The pull-request fields the renderer and the filter read, and nothing else.
 *  `additions` / `deletions` / `changed_files` ride along in the webhook, so a
 *  pull request costs no GitHub subrequest at all. */
const pullRequest = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  /** Absent on the shorter representation sent with a review event. */
  changed_files: z.number().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  user: z.object({ login: z.string() }),
});

export const pullRequestPayload = z.object({
  action: z.string(),
  pull_request: pullRequest,
  repository,
  sender,
});

export const pullRequestReviewPayload = pullRequestPayload.extend({
  review: z.object({
    id: z.number(),
    /** `approved`, `changes_requested`, `commented`, and whatever GitHub adds next;
     *  the filter decides which of them render. */
    state: z.string(),
    html_url: z.string(),
    user: z.object({ login: z.string() }),
  }),
});

export type PullRequestPayload = z.infer<typeof pullRequestPayload>;
export type PullRequestReviewPayload = z.infer<typeof pullRequestReviewPayload>;
