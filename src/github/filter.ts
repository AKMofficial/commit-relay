/** Every skip decision plus a reason code and the patterns that were tried
 *  (7.6, 9.8). No I/O: the only injected capability is the logger. */

import type { LogFn } from '../obs/log.ts';
import type { Metrics } from '../obs/metrics.ts';
import {
  isRouteMatch,
  type CompiledRouting,
  type NormalizedCommit,
  type ParsedRef,
  type PullRequestEvent,
  type PullRequestKind,
  type PushEvent,
  type RollupKind,
  type RouteMatch,
  type SkipReason,
} from '../core/types.ts';
import { classifyRef } from './ref.ts';
import { COMMITS_ARRAY_CAP } from './parse.ts';

const ZERO_SHA = '0000000000000000000000000000000000000000';

export interface DecideContext {
  log: LogFn;
  deliveryId: string;
  /** Every skip is counted here: `skippedTotal` is the branch-allowlist
   *  diagnostic of 14.5 and has to move when a push is filtered out. */
  metrics?: Metrics;
}

type SkipDecision = {
  kind: 'skip';
  reason: SkipReason;
  matchedRoute: string | null;
  patternsTried?: string[];
};

export type PushDecision =
  | SkipDecision
  | {
      kind: 'rollup';
      rollupKind: RollupKind;
      commits: NormalizedCommit[];
      ref: ParsedRef;
      route: RouteMatch;
    }
  | {
      kind: 'commits';
      commits: NormalizedCommit[];
      ref: ParsedRef;
      /** Ids whose message looks like a merge. The authoritative `parents.length`
       *  check runs after enrichment (9.8), so these are flagged, not dropped. */
      mergeCandidates: ReadonlySet<string>;
      route: RouteMatch;
    };

function looksLikeMerge(message: string): boolean {
  return message.startsWith('Merge ');
}

function ignoredAuthor(event: PushEvent, commit: NormalizedCommit, route: RouteMatch): boolean {
  const match = route.ignoreAuthorsMatcher;
  return (
    match(event.senderLogin) ||
    (commit.authorUsername !== null && match(commit.authorUsername)) ||
    match(commit.authorEmail)
  );
}

export function decidePush(
  event: PushEvent,
  routing: CompiledRouting,
  ctx: DecideContext,
): PushDecision {
  const classified = classifyRef(event.ref);
  const parsedRef = classified.kind === 'branch' || classified.kind === 'tag' ? classified : null;

  // Every skip is `info`, never `debug`: "my push did not appear" is the number
  // one support report and the answer has to be at the default log level (7.6).
  const logSkip = (
    reason: SkipReason,
    matchedRoute: string | null,
    patternsTried?: string[],
    extra?: Record<string, unknown>,
  ): void => {
    ctx.log('info', 'push_skipped', {
      reason,
      repo: event.repoFullName,
      ref: event.ref,
      refKind: parsedRef?.kind ?? null,
      refName: parsedRef?.name ?? null,
      matchedRoute,
      patternsTried,
      deliveryId: ctx.deliveryId,
      commits: event.commits.length,
      ...extra,
    });
    ctx.metrics?.inc('skippedTotal');
  };
  const skip = (
    reason: SkipReason,
    matchedRoute: string | null,
    patternsTried?: string[],
  ): PushDecision => {
    logSkip(reason, matchedRoute, patternsTried);
    return { kind: 'skip', reason, matchedRoute, ...(patternsTried ? { patternsTried } : {}) };
  };

  // Before any field of a deleted ref is dereferenced: this is the row that
  // prevents a null-deref on `head_commit` (9.8).
  if (event.deleted) return skip('branch_deleted', null);
  if (classified.kind === 'too_long') return skip('skip_ref_too_long', null);
  if (classified.kind === 'unknown') return skip('skip_not_a_ref', null);
  const ref = classified;

  const decision = routing.matchRoute(event.repoFullName, ref);
  if (!isRouteMatch(decision)) {
    return skip(decision.skipped, decision.matchedRoute, decision.patternsTried);
  }
  const route = decision;

  if (event.forced) {
    if (route.options.skipForcedPushes) return skip('forced_push', route.matchedRoute);
    return { kind: 'rollup', rollupKind: 'forced', commits: event.commits, ref, route };
  }

  // A branch create only; a tag's `before` is all zeros on every first push and
  // has its own rollup-free path (9.8).
  if (ref.kind === 'branch' && event.before === ZERO_SHA && event.created) {
    return { kind: 'rollup', rollupKind: 'branch_create', commits: event.commits, ref, route };
  }

  const survivors: NormalizedCommit[] = [];
  const mergeCandidates = new Set<string>();
  for (const commit of event.commits) {
    if (route.options.skipNonDistinct && !commit.distinct) {
      logSkip('non_distinct', route.matchedRoute, undefined, { commit: commit.id });
      continue;
    }
    if (route.options.ignoreAuthors.length > 0 && ignoredAuthor(event, commit, route)) {
      logSkip('author_ignored', route.matchedRoute, route.options.ignoreAuthors, {
        commit: commit.id,
      });
      continue;
    }
    if (route.options.skipMergeCommits && looksLikeMerge(commit.message)) {
      mergeCandidates.add(commit.id);
    }
    survivors.push(commit);
  }

  if (survivors.length === 0) return skip('no_commits', route.matchedRoute);

  // Either reading of GitHub's array cap collapses the push to one line (9.8).
  if (
    survivors.length > route.options.maxCommitsPerPush ||
    event.commits.length >= COMMITS_ARRAY_CAP
  ) {
    return { kind: 'rollup', rollupKind: 'cap', commits: survivors, ref, route };
  }

  return { kind: 'commits', commits: survivors, mergeCandidates, ref, route };
}

export type PullRequestDecision =
  | SkipDecision
  | { kind: 'post'; prKind: PullRequestKind; ref: ParsedRef; route: RouteMatch };

/** Actions GitHub sends on the `pull_request` event that this version can
 *  render; `closed` is two different lines, and which one it is lives in `merged`. */
const PR_ACTION_KIND: ReadonlyMap<string, PullRequestKind> = new Map([
  ['opened', 'opened'],
  ['reopened', 'reopened'],
  ['ready_for_review', 'ready_for_review'],
]);

/** GitHub's review states, lowercased. `commented` is deliberately absent: it
 *  fires for every review comment and would drown the room. Anything else is a
 *  state this version does not render, and it is dropped rather than guessed at. */
const REVIEW_STATE_KIND: ReadonlyMap<string, PullRequestKind> = new Map([
  ['approved', 'review_approved'],
  ['changes_requested', 'review_changes_requested'],
]);

function resolvePullRequestKind(event: PullRequestEvent): PullRequestKind | null {
  if (event.reviewState !== undefined) {
    if (event.action !== 'submitted') return null;
    return REVIEW_STATE_KIND.get(event.reviewState.toLowerCase()) ?? null;
  }
  if (event.action === 'closed') return event.merged ? 'merged' : 'closed';
  return PR_ACTION_KIND.get(event.action) ?? null;
}

/**
 * A pull request is routed by its **base** branch, so `branches: ['main']` reads
 * as "pull requests targeting main" and the queue consumer's single routing
 * entry point serves pushes and pull requests alike.
 */
export function decidePullRequest(
  event: PullRequestEvent,
  routing: CompiledRouting,
  ctx: DecideContext,
): PullRequestDecision {
  const ref: ParsedRef = { kind: 'branch', name: event.baseRef };
  const isReview = event.reviewState !== undefined;
  const kind = resolvePullRequestKind(event);
  const unrenderable = isReview ? event.action !== 'submitted' : kind === null;

  // GitHub cannot narrow a subscription per action, so `synchronize`, `labeled`,
  // `edited` and the rest all arrive here. They are noise, not a decision, so
  // they log at debug and never move `skippedTotal`, exactly like a non-push
  // event in the webhook handler. A review is relayed on `submitted` only: an
  // `edited` review keeps its state and would post the same line twice.
  if (unrenderable) {
    ctx.log('debug', 'pull_request_action_ignored', {
      repo: event.repoFullName,
      action: event.action,
      pr: event.number,
      review: isReview,
      deliveryId: ctx.deliveryId,
    });
    return { kind: 'skip', reason: 'pr_action_ignored', matchedRoute: null };
  }

  const skip = (
    reason: SkipReason,
    matchedRoute: string | null,
    patternsTried?: string[],
  ): PullRequestDecision => {
    ctx.log('info', 'pull_request_skipped', {
      reason,
      repo: event.repoFullName,
      action: event.action,
      pr: event.number,
      baseRef: event.baseRef,
      matchedRoute,
      patternsTried,
      deliveryId: ctx.deliveryId,
    });
    ctx.metrics?.inc('skippedTotal');
    return { kind: 'skip', reason, matchedRoute, ...(patternsTried ? { patternsTried } : {}) };
  };

  const decision = routing.matchRoute(event.repoFullName, ref);
  if (!isRouteMatch(decision)) {
    // The base branch failed the branch allowlist, which for a pull request is
    // its own reason code: `branch_not_allowed` would read as a push.
    const reason = decision.skipped === 'branch_not_allowed' ? 'pr_base_not_allowed' : decision.skipped;
    return skip(reason, decision.matchedRoute, decision.patternsTried);
  }
  const route = decision;

  if (isReview) {
    if (!route.options.prReviews) return skip('pr_action_ignored', route.matchedRoute);
  } else if (!route.options.prActions.includes(event.action)) {
    return skip('pr_action_ignored', route.matchedRoute, route.options.prActions);
  }

  // A draft is work in progress; `ready_for_review` is the moment it stops being
  // one, so that action is never suppressed by this. Neither is a review: a
  // review on a draft is someone choosing to look at it, which is the news.
  const draftGated = !isReview && event.draft && kind !== 'ready_for_review';
  if (route.options.prSkipDrafts && draftGated) {
    return skip('pr_draft', route.matchedRoute);
  }

  if (route.options.ignoreAuthors.length > 0 && route.ignoreAuthorsMatcher(event.author)) {
    return skip('author_ignored', route.matchedRoute, route.options.ignoreAuthors);
  }

  if (kind === null) return skip('pr_action_ignored', route.matchedRoute);

  return { kind: 'post', prKind: kind, ref, route };
}
