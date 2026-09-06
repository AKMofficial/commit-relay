/** The domain vocabulary. This module imports nothing: every other folder
 *  depends on it, so an import here would be a cycle by construction. */

/** A compiled pattern, implemented by src/config/glob.ts. Declared here so the
 *  routing types below name the interface rather than the implementation. */
export type GlobMatcher = (subject: string) => boolean;

/** From `GET /repos/{owner}/{repo}/commits/{sha}` (9.5); `parentsCount` is what
 *  identifies a merge commit. */
export interface CommitStats {
  additions: number;
  deletions: number;
  total: number;
  parentsCount: number;
}

export type RefKind = 'branch' | 'tag';

export interface ParsedRef {
  kind: RefKind;
  name: string;
}

/** The consumed pull-request paths and nothing else, sanitized and truncated at
 *  ingest exactly as a push is. `merged` and `draft` are resolved here so the
 *  filter and the renderer both read a boolean rather than re-deriving it. */
export interface PullRequestEvent {
  action: string;
  merged: boolean;
  draft: boolean;
  number: number;
  title: string;
  htmlUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  author: string;
  fileCount: number | null;
  additions: number | null;
  deletions: number | null;
  repoFullName: string;
  /** Review events only. */
  reviewState?: string;
  reviewId?: number;
}

/** The 24 consumed paths and nothing else, sanitized and truncated at ingest (9.4). */
export interface PushEvent {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  compare: string;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  repoHtmlUrl: string;
  senderLogin: string;
  senderType: string;
  commits: NormalizedCommit[];
  /** The UNION of `added + removed + modified` across the push (8.4): summing
   *  per-commit `fileCount` would double-count a file touched by two commits. */
  changedPathCount: number;
}

/** `authorUsername` is null when GitHub could not map the commit email to an account. */
export interface NormalizedCommit {
  id: string;
  message: string;
  url: string;
  distinct: boolean;
  authorName: string;
  authorEmail: string;
  authorUsername: string | null;
  fileCount: number;
  /** A message-shape hint only: the authoritative `parents.length > 1` check
   *  runs after enrichment (9.8). */
  mergeCandidate?: boolean;
}

/** Every value is already resolved: no env-var name reaches this type, so
 *  nothing downstream reads the environment. */
export interface ResolvedTarget {
  accountId: string;
  chatbotKey: string;
  bucketId: string;
  chatId: string;
  apiBase: string;
  githubToken: string | null;
  githubApiBase: string;
  webOrigin: string;
}

export interface RouteOptions {
  skipMergeCommits: boolean;
  skipForcedPushes: boolean;
  skipNonDistinct: boolean;
  ignoreAuthors: string[];
  maxCommitsPerPush: number;
  prActions: string[];
  prReviews: boolean;
  prSkipDrafts: boolean;
}

export const ROLLUP_KINDS = ['cap', 'branch_create', 'forced'] as const;

export type RollupKind = (typeof ROLLUP_KINDS)[number];

/** What every relayed job carries, whatever GitHub event produced it. `refKind`
 *  and `refName` are here because the queue consumer re-routes off them: for a
 *  push they are the pushed ref, for a pull request the **base** branch, so one
 *  routing entry point serves both. */
export interface JobBase {
  deliveryId: string;
  repoFullName: string;
  refKind: RefKind;
  refName: string;
  target: ResolvedTarget;
  options: RouteOptions;
  /** Times this job was re-queued after a deferral. */
  deferrals?: number;
}

/** Exactly one per push (4.4). `commits` is already sanitized and truncated, so
 *  a queued job can never retain a multi-megabyte string. */
export interface PushJob extends JobBase {
  type: 'push';
  ref: string;
  before: string;
  after: string;
  compareUrl: string;
  forced: boolean;
  created: boolean;
  commits: NormalizedCommit[];
  /** Ingest-time union of changed paths across commits; kept on per-commit jobs so a
   *  queue-oversize collapse can still fill the Files row (8.4). */
  changedPathCount?: number | null;
  /** `fileCount` is the ingest-time union of the changed paths across commits:
   *  the rollup fetches nothing, and summing per-commit counts would double-count. */
  rollup?: { kind: RollupKind; fileCount: number | null; authors: string[] };
  /** First seq to post; earlier seqs were posted by a prior invocation (Workers
   *  redelivery). Push-only on purpose: a single-post job has no partial
   *  progress, and keeping it off `PullRequestJob` makes the compiler say so. */
  resumeAtSeq?: number;
}

/** Selects the label row and nothing else, exactly as `RollupKind` does. A pull
 *  request that was closed without merging is a different line from one that was
 *  merged, so the merge outcome is resolved at ingest rather than at render. */
export const PULL_REQUEST_KINDS = [
  'opened',
  'merged',
  'closed',
  'reopened',
  'ready_for_review',
  'review_approved',
  'review_changes_requested',
] as const;

export type PullRequestKind = (typeof PULL_REQUEST_KINDS)[number];

/** Exactly one message per job: the line counts arrive in the webhook payload,
 *  so unlike a commit this never costs a GitHub subrequest. */
export interface PullRequestJob extends JobBase {
  type: 'pull_request';
  kind: PullRequestKind;
  number: number;
  title: string;
  htmlUrl: string;
  /** The head branch. The base branch is `refName`, which is also what routes. */
  headRef: string;
  headSha: string;
  author: string;
  fileCount: number | null;
  additions: number | null;
  deletions: number | null;
  /** Review events only, where it is the dedup identity. */
  reviewId?: number;
}

export type RelayJob = PushJob | PullRequestJob;

/** `Omit` over a union collapses it to one object type and loses the
 *  discriminant, so the omit has to distribute over the members. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What crosses the Cloudflare Queue: a job minus everything resolved from
 *  config. The consumer rebuilds `target` and `options` from its own config (11.1). */
export type QueuedJob = DistributiveOmit<RelayJob, 'target' | 'options'>;

export function toQueuedJob(job: RelayJob): QueuedJob {
  const { target, options, ...rest } = job;
  void target;
  void options;
  return rest;
}

/** Distinct `author.username ?? author.name`, in first-seen order (8.4). */
export function rollupAuthors(commits: readonly NormalizedCommit[]): string[] {
  const seen = new Set<string>();
  for (const commit of commits) seen.add(commit.authorUsername ?? commit.authorName);
  return [...seen];
}

export interface CommitJob {
  seq: number;
  commit: NormalizedCommit;
  state: 'pending' | 'ready' | 'posted' | 'failed' | 'skipped';
  stats: Pick<CommitStats, 'additions' | 'deletions'> | null;
  /** Absent until enrichment resolves. */
  parentsCount?: number;
}

export interface RelayResult {
  posted: number;
  failed: number;
  skipped: number;
  dropped: number;
}

/** The closed vocabulary of 7.6: a skip that fits none of these is a missing
 *  code, not free text. Only the two malformed-ref codes carry the `skip_` prefix. */
export const SKIP_REASONS = [
  'repo_not_allowed',
  'no_route',
  'skip_not_a_ref',
  'skip_ref_too_long',
  'branch_not_allowed',
  'tags_disabled',
  'tag_not_allowed',
  'branch_deleted',
  'no_commits',
  'forced_push',
  'merge_commit',
  'non_distinct',
  'author_ignored',
  'pr_action_ignored',
  'pr_draft',
  'pr_base_not_allowed',
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

/** Lives here rather than in src/config (7.5) so the compiler that produces it
 *  and the filter that consumes it depend on the domain, not on each other. */
export interface RouteMatch {
  target: ResolvedTarget;
  options: RouteOptions;
  branches: string[];
  tags: string[];
  /** Null for the fallthrough route. */
  matchedRoute: string | null;
  /** Names the variable whose secret verifies this route's deliveries (7.5). */
  webhookSecretEnv?: string;
  branchMatcher: GlobMatcher;
  tagMatcher: GlobMatcher;
  ignoreAuthorsMatcher: GlobMatcher;
}

export type RouteDecision =
  | RouteMatch
  | { skipped: SkipReason; patternsTried: string[]; matchedRoute: string | null };

export function isRouteMatch(decision: RouteDecision): decision is RouteMatch {
  return !('skipped' in decision);
}

export interface CompiledRouting {
  matchRoute(repoFullName: string, ref: ParsedRef): RouteDecision;
  /** The secret that authorizes this repo, independent of ref filtering: `undefined`
   *  when the repo resolves to no route at all, otherwise the route's
   *  `webhookSecretEnv` (`null` meaning the global secret). */
  expectedSecretEnv(repoFullName: string): string | null | undefined;
}
