import { describe, expect, it } from 'vitest';
import type { LogFn } from '../obs/log.ts';
import type { PullRequestEvent, PushEvent } from '../core/types.ts';
import { getConfig } from '../config/load.ts';
import { compileRoutes } from '../config/routing.ts';
import { parsePullRequest, parsePullRequestReview, parsePush } from './parse.ts';
import { SKIP_REASONS, type SkipReason } from '../core/types.ts';
import {
  decidePullRequest,
  decidePush,
  type PullRequestDecision,
  type PushDecision,
} from './filter.ts';
import { createFakeMetrics } from '../../tests/fake-metrics.ts';
import branchCreateRaw from '../../tests/fixtures/push.branch-create.json?raw';
import branchDeleteRaw from '../../tests/fixtures/push.branch-delete.json?raw';
import tagRaw from '../../tests/fixtures/push.tag.json?raw';
import tagWithCommitsRaw from '../../tests/fixtures/push.tag-with-commits.json?raw';
import forcedRaw from '../../tests/fixtures/push.forced.json?raw';
import mergeRaw from '../../tests/fixtures/push.merge.json?raw';
import nonDistinctRaw from '../../tests/fixtures/push.non-distinct.json?raw';
import emptyRaw from '../../tests/fixtures/push.empty.json?raw';
import botRaw from '../../tests/fixtures/push.bot.json?raw';
import largeRaw from '../../tests/fixtures/push.large.json?raw';
import unknownFieldsRaw from '../../tests/fixtures/push.unknown-fields.json?raw';
import prOpenedRaw from '../../tests/fixtures/pr.opened.json?raw';
import prMergedRaw from '../../tests/fixtures/pr.merged.json?raw';
import prClosedRaw from '../../tests/fixtures/pr.closed.json?raw';
import prReopenedRaw from '../../tests/fixtures/pr.reopened.json?raw';
import prDraftRaw from '../../tests/fixtures/pr.draft.json?raw';
import prReadyRaw from '../../tests/fixtures/pr.ready-for-review.json?raw';
import reviewApprovedRaw from '../../tests/fixtures/review.approved.json?raw';
import reviewChangesRaw from '../../tests/fixtures/review.changes-requested.json?raw';

const BASE: Record<string, string> = {
  GITHUB_WEBHOOK_SECRET: 'f3a91c07be24d85a6f0b1c72e94d3a58',
  BASECAMP_ACCOUNT_ID: '1234567',
  BASECAMP_CHATBOT_KEY: 'chatbot-key-aaaaaaaa',
  BASECAMP_BUCKET_ID: '2345678',
  BASECAMP_CHAT_ID: '7654321',
  BRANCHES: '**',
};

const DELIVERY = '5f8a0c2e-1b3d-4a6f-8c9e-0d1b2a3c4d5e';

interface Line {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

function load(raw: string): PushEvent {
  const result = parsePush(JSON.parse(raw), { commitBodyMaxChars: 2000 }, () => {});
  if (!result.ok) throw new Error(`fixture did not parse: ${JSON.stringify(result.issues)}`);
  return result.event;
}

function decide(raw: string, env: Record<string, string> = {}): { decision: PushDecision; lines: Line[] } {
  const source = { ...BASE, ...env };
  const lines: Line[] = [];
  const log: LogFn = (level, event, fields) => {
    lines.push({ level, event, fields: fields ?? {} });
  };
  const routing = compileRoutes(getConfig(source), source);
  return { decision: decidePush(load(raw), routing, { log, deliveryId: DELIVERY }), lines };
}

function skipReasons(lines: Line[]): SkipReason[] {
  return lines.filter((l) => l.event === 'push_skipped').map((l) => l.fields['reason'] as SkipReason);
}

function loadPr(raw: string, isReview = false): PullRequestEvent {
  const parse = isReview ? parsePullRequestReview : parsePullRequest;
  const result = parse(JSON.parse(raw), { commitBodyMaxChars: 2000 }, () => {});
  if (!result.ok) throw new Error(`fixture did not parse: ${JSON.stringify(result.issues)}`);
  return result.event;
}

function decidePr(
  raw: string,
  env: Record<string, string> = {},
  isReview = false,
): { decision: PullRequestDecision; lines: Line[] } {
  const source = { ...BASE, ...env };
  const lines: Line[] = [];
  const log: LogFn = (level, event, fields) => {
    lines.push({ level, event, fields: fields ?? {} });
  };
  const routing = compileRoutes(getConfig(source), source);
  return {
    decision: decidePullRequest(loadPr(raw, isReview), routing, { log, deliveryId: DELIVERY }),
    lines,
  };
}

function prSkipReasons(lines: Line[]): SkipReason[] {
  return lines
    .filter((l) => l.event === 'pull_request_skipped')
    .map((l) => l.fields['reason'] as SkipReason);
}

describe('the closed reason vocabulary', () => {
  it('is the sixteen strings of 7.6', () => {
    expect([...SKIP_REASONS]).toEqual([
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
    ]);
  });
});

describe('the fixture catalogue (17.4)', () => {
  it('push.branch-create.json produces one branch_create rollup', () => {
    const { decision } = decide(branchCreateRaw);
    expect(decision).toMatchObject({ kind: 'rollup', rollupKind: 'branch_create' });
    if (decision.kind === 'rollup') expect(decision.commits).toHaveLength(4);
  });

  it('push.branch-delete.json is dropped with branch_deleted', () => {
    const { decision, lines } = decide(branchDeleteRaw);
    expect(decision).toMatchObject({ kind: 'skip', reason: 'branch_deleted' });
    expect(skipReasons(lines)).toEqual(['branch_deleted']);
  });

  it('push.tag.json posts nothing under every TAGS value', () => {
    expect(decide(tagRaw).decision).toMatchObject({ kind: 'skip', reason: 'tags_disabled' });
    expect(decide(tagRaw, { TAGS: 'v*' }).decision).toMatchObject({
      kind: 'skip',
      reason: 'no_commits',
    });
  });

  it('push.tag-with-commits.json is dropped by default and posts one commit with TAGS=v*', () => {
    expect(decide(tagWithCommitsRaw).decision).toMatchObject({
      kind: 'skip',
      reason: 'tags_disabled',
    });
    const { decision } = decide(tagWithCommitsRaw, { TAGS: 'v*' });
    expect(decision.kind).toBe('commits');
    if (decision.kind === 'commits') expect(decision.commits).toHaveLength(1);
  });

  it('push.forced.json has exactly two outcomes and no third', () => {
    expect(decide(forcedRaw).decision).toMatchObject({ kind: 'rollup', rollupKind: 'forced' });
    const skipped = decide(forcedRaw, { SKIP_FORCED_PUSHES: 'true' });
    expect(skipped.decision).toMatchObject({ kind: 'skip', reason: 'forced_push' });
    expect(skipReasons(skipped.lines)).toEqual(['forced_push']);
  });

  it('push.merge.json keeps all three commits and flags the merge candidate', () => {
    const { decision } = decide(mergeRaw);
    expect(decision.kind).toBe('commits');
    if (decision.kind !== 'commits') return;
    // 9.8: merge commits are flagged at ingest, never dropped.
    expect(decision.commits).toHaveLength(3);
    const merge = decision.commits.find((c) => c.message.startsWith('Merge pull request'));
    expect(merge).toBeDefined();
    expect(decision.mergeCandidates.has(merge?.id ?? '')).toBe(true);
    expect(decision.mergeCandidates.size).toBe(1);
  });

  it('push.merge.json flags nothing when skipMergeCommits is off', () => {
    const { decision } = decide(mergeRaw, { SKIP_MERGE_COMMITS: 'false' });
    if (decision.kind !== 'commits') throw new Error('expected commits');
    expect(decision.mergeCandidates.size).toBe(0);
  });

  it('push.non-distinct.json posts nothing by default', () => {
    const { decision, lines } = decide(nonDistinctRaw);
    expect(decision).toMatchObject({ kind: 'skip', reason: 'no_commits' });
    expect(skipReasons(lines)).toEqual(['non_distinct', 'non_distinct', 'no_commits']);
  });

  it('push.non-distinct.json posts both commits when the skip is off', () => {
    const { decision } = decide(nonDistinctRaw, { SKIP_NON_DISTINCT: 'false' });
    if (decision.kind !== 'commits') throw new Error('expected commits');
    expect(decision.commits).toHaveLength(2);
  });

  it('push.empty.json is dropped with no_commits', () => {
    expect(decide(emptyRaw).decision).toMatchObject({ kind: 'skip', reason: 'no_commits' });
  });

  it('push.bot.json posts nothing with IGNORE_AUTHORS=dependabot[bot]', () => {
    const { decision, lines } = decide(botRaw, { IGNORE_AUTHORS: 'dependabot[bot]' });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'no_commits' });
    expect(skipReasons(lines)).toEqual(['author_ignored', 'no_commits']);
    const withoutList = decide(botRaw).decision;
    expect(withoutList.kind).toBe('commits');
  });

  it('matches IGNORE_AUTHORS against the author email as well', () => {
    const { decision } = decide(mergeRaw, { IGNORE_AUTHORS: '*@example.com' });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'no_commits' });
  });

  it('push.large.json produces one cap rollup and no per-commit tables', () => {
    const { decision } = decide(largeRaw);
    expect(decision).toMatchObject({ kind: 'rollup', rollupKind: 'cap' });
    if (decision.kind === 'rollup') expect(decision.commits).toHaveLength(30);
    expect(decide(largeRaw, { MAX_COMMITS_PER_PUSH: '30' }).decision.kind).toBe('commits');
  });

  it('push.unknown-fields.json processes normally', () => {
    const { decision } = decide(unknownFieldsRaw);
    expect(decision.kind).toBe('commits');
    if (decision.kind === 'commits') expect(decision.commits).toHaveLength(2);
  });
});

describe('the cap rollup fires on either reading of the array cap', () => {
  it('fires at commits.length >= 2048 even when the survivors are under the cap', () => {
    const event = load(largeRaw);
    const padded: PushEvent = {
      ...event,
      commits: Array.from({ length: 2048 }, (_, i) => ({
        ...(event.commits[0] as PushEvent['commits'][number]),
        id: i.toString(16).padStart(40, '0'),
      })),
    };
    const source = { ...BASE, MAX_COMMITS_PER_PUSH: '100' };
    const routing = compileRoutes(getConfig(source), source);
    const decision = decidePush(padded, routing, { log: () => {}, deliveryId: DELIVERY });
    expect(decision).toMatchObject({ kind: 'rollup', rollupKind: 'cap' });
  });
});

describe('the gate ladder', () => {
  const withRef = (raw: string, ref: string): PushEvent => ({ ...load(raw), ref });

  function decideEvent(event: PushEvent, env: Record<string, string> = {}) {
    const source = { ...BASE, ...env };
    const lines: Line[] = [];
    const log: LogFn = (level, event_, fields) => {
      lines.push({ level, event: event_, fields: fields ?? {} });
    };
    const routing = compileRoutes(getConfig(source), source);
    return { decision: decidePush(event, routing, { log, deliveryId: DELIVERY }), lines };
  }

  it('rejects a ref that is neither a branch nor a tag', () => {
    const { decision } = decideEvent(withRef(mergeRaw, 'refs/pull/42/merge'));
    expect(decision).toMatchObject({ kind: 'skip', reason: 'skip_not_a_ref' });
  });

  it('rejects a ref over the 512-byte cap', () => {
    const { decision } = decideEvent(withRef(mergeRaw, `refs/heads/${'a'.repeat(600)}`));
    expect(decision).toMatchObject({ kind: 'skip', reason: 'skip_ref_too_long' });
  });

  it('applies REPO_ALLOWLIST before routing', () => {
    const { decision } = decideEvent(load(mergeRaw), { REPO_ALLOWLIST: 'other-org/*' });
    expect(decision).toMatchObject({
      kind: 'skip',
      reason: 'repo_not_allowed',
      patternsTried: ['other-org/*'],
    });
  });

  it('drops an unrouted repo with no_route', () => {
    const routes = JSON.stringify({ routes: [{ repo: 'other-org/*' }], fallthrough: 'ignore' });
    const { decision } = decideEvent(load(mergeRaw), { ROUTES: routes });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'no_route' });
  });

  it('drops a branch outside the allowlist', () => {
    const { decision } = decideEvent(load(mergeRaw), { BRANCHES: 'release/*' });
    expect(decision).toMatchObject({
      kind: 'skip',
      reason: 'branch_not_allowed',
      patternsTried: ['release/*'],
    });
  });

  it('never matches a tag ref against the branch allowlist', () => {
    const { decision } = decideEvent(load(tagWithCommitsRaw), { BRANCHES: '**' });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'tags_disabled' });
    const notAllowed = decideEvent(load(tagWithCommitsRaw), { TAGS: 'nightly-*' });
    expect(notAllowed.decision).toMatchObject({
      kind: 'skip',
      reason: 'tag_not_allowed',
      patternsTried: ['nightly-*'],
    });
  });

  it('logs every skip at info with the reason, the patterns tried and the delivery id', () => {
    const { lines } = decideEvent(load(mergeRaw), { BRANCHES: 'release/*' });
    const line = lines.find((l) => l.event === 'push_skipped');
    expect(line?.level).toBe('info');
    expect(line?.fields).toMatchObject({
      reason: 'branch_not_allowed',
      repo: 'your-org/your-repo',
      ref: 'refs/heads/main',
      refKind: 'branch',
      refName: 'main',
      matchedRoute: null,
      patternsTried: ['release/*'],
      deliveryId: DELIVERY,
      commits: 3,
    });
  });

  it('reaches every reason code that is decidable at ingest', () => {
    const reached = new Set<SkipReason>();
    const collect = (result: { lines: Line[] }) => {
      for (const reason of skipReasons(result.lines)) reached.add(reason);
    };
    collect(decideEvent(load(mergeRaw), { REPO_ALLOWLIST: 'other-org/*' }));
    collect(
      decideEvent(load(mergeRaw), {
        ROUTES: JSON.stringify({ routes: [{ repo: 'other-org/*' }] }),
      }),
    );
    collect(decideEvent(withRef(mergeRaw, 'refs/pull/42/merge')));
    collect(decideEvent(withRef(mergeRaw, `refs/heads/${'a'.repeat(600)}`)));
    collect(decideEvent(load(mergeRaw), { BRANCHES: 'release/*' }));
    collect(decideEvent(load(tagRaw)));
    collect(decideEvent(load(tagWithCommitsRaw), { TAGS: 'nightly-*' }));
    collect(decideEvent(load(branchDeleteRaw)));
    collect(decideEvent(load(emptyRaw)));
    collect(decideEvent(load(forcedRaw), { SKIP_FORCED_PUSHES: 'true' }));
    collect(decideEvent(load(nonDistinctRaw)));
    collect(decideEvent(load(botRaw), { IGNORE_AUTHORS: 'dependabot[bot]' }));

    const collectPr = (result: { lines: Line[] }) => {
      for (const reason of prSkipReasons(result.lines)) reached.add(reason);
    };
    collectPr(decidePr(prOpenedRaw, { PR_ACTIONS: 'closed' }));
    collectPr(decidePr(prDraftRaw));
    collectPr(decidePr(prOpenedRaw, { BRANCHES: 'release/*' }));

    // 9.8: `merge_commit` is the one skip code no ingest decision can emit.
    expect([...reached].sort()).toEqual(
      SKIP_REASONS.filter((r) => r !== 'merge_commit')
        .slice()
        .sort(),
    );
  });
});

describe('skippedTotal', () => {
  it('counts a branch-not-allowed push, the branch-allowlist diagnostic of 14.5', () => {
    const source = { ...BASE, BRANCHES: 'main' };
    const metrics = createFakeMetrics();
    const routing = compileRoutes(getConfig(source), source);
    const event = { ...load(branchCreateRaw), ref: 'refs/heads/feature/x', created: false, before: 'a'.repeat(40) };
    const decision = decidePush(event, routing, { log: () => {}, deliveryId: DELIVERY, metrics });

    expect(decision.kind).toBe('skip');
    expect(metrics.values.skippedTotal).toBe(1);
    expect(metrics.snapshot().skippedTotal).toBe(1);
  });
});

describe('decidePullRequest', () => {
  it('maps each fixture to the kind its label is selected by', () => {
    expect(decidePr(prOpenedRaw).decision).toMatchObject({ kind: 'post', prKind: 'opened' });
    expect(decidePr(prMergedRaw).decision).toMatchObject({ kind: 'post', prKind: 'merged' });
    expect(decidePr(prClosedRaw).decision).toMatchObject({ kind: 'post', prKind: 'closed' });
    expect(decidePr(prReopenedRaw).decision).toMatchObject({ kind: 'post', prKind: 'reopened' });
    expect(decidePr(prReadyRaw).decision).toMatchObject({
      kind: 'post',
      prKind: 'ready_for_review',
    });
  });

  it('separates a merged pull request from one closed without merging', () => {
    // Both arrive as action `closed`; only `merged` tells them apart.
    expect(decidePr(prMergedRaw).decision).toMatchObject({ prKind: 'merged' });
    expect(decidePr(prClosedRaw).decision).toMatchObject({ prKind: 'closed' });
  });

  it('renders reviews under their own kinds when PR_REVIEWS is on', () => {
    expect(decidePr(reviewApprovedRaw, {}, true).decision).toMatchObject({
      kind: 'post',
      prKind: 'review_approved',
    });
    expect(decidePr(reviewChangesRaw, {}, true).decision).toMatchObject({
      kind: 'post',
      prKind: 'review_changes_requested',
    });
  });

  it('drops every review when PR_REVIEWS is off, whatever PR_ACTIONS says', () => {
    const { decision, lines } = decidePr(reviewApprovedRaw, { PR_REVIEWS: 'false' }, true);
    expect(decision).toMatchObject({ kind: 'skip', reason: 'pr_action_ignored' });
    expect(prSkipReasons(lines)).toEqual(['pr_action_ignored']);
  });

  it('drops a draft on opened but never on ready_for_review', () => {
    expect(decidePr(prDraftRaw).decision).toMatchObject({ kind: 'skip', reason: 'pr_draft' });
    expect(decidePr(prReadyRaw).decision).toMatchObject({ kind: 'post' });
  });

  it('keeps a draft when PR_SKIP_DRAFTS is off', () => {
    expect(decidePr(prDraftRaw, { PR_SKIP_DRAFTS: 'false' }).decision).toMatchObject({
      kind: 'post',
      prKind: 'opened',
    });
  });

  it('routes on the base branch, not the head branch', () => {
    // The fixture is feat/login -> main.
    expect(decidePr(prOpenedRaw, { BRANCHES: 'main' }).decision).toMatchObject({ kind: 'post' });
    expect(decidePr(prOpenedRaw, { BRANCHES: 'feat/*' }).decision).toMatchObject({
      kind: 'skip',
      reason: 'pr_base_not_allowed',
    });
  });

  it('honours IGNORE_AUTHORS against the pull request author', () => {
    expect(decidePr(prOpenedRaw, { IGNORE_AUTHORS: 'jane-doe' }).decision).toMatchObject({
      kind: 'skip',
      reason: 'author_ignored',
    });
  });

  it('drops an action outside PR_ACTIONS and names the patterns it tried', () => {
    const { decision, lines } = decidePr(prOpenedRaw, { PR_ACTIONS: 'closed' });
    expect(decision).toMatchObject({ kind: 'skip', reason: 'pr_action_ignored' });
    expect(lines[0]?.fields['patternsTried']).toEqual(['closed']);
  });

  it('posts a review on a draft pull request even with PR_SKIP_DRAFTS on', () => {
    const approved = JSON.parse(reviewApprovedRaw) as {
      pull_request: { draft: boolean };
      review: { state: string };
    };
    const raw = JSON.stringify({
      ...approved,
      pull_request: { ...approved.pull_request, draft: true },
    });
    expect(decidePr(raw, {}, true).decision).toMatchObject({ kind: 'post', prKind: 'review_approved' });
  });

  it('relays a review on submitted only, so an edited approval never posts twice', () => {
    const approved = JSON.parse(reviewApprovedRaw) as { action: string };
    const { decision, lines } = decidePr(JSON.stringify({ ...approved, action: 'edited' }), {}, true);
    expect(decision).toMatchObject({ kind: 'skip', reason: 'pr_action_ignored' });
    expect(lines).toEqual([
      expect.objectContaining({ level: 'debug', event: 'pull_request_action_ignored' }),
    ]);
  });

  it('ignores an action this version cannot render at debug, without touching skippedTotal', () => {
    const opened = JSON.parse(prOpenedRaw) as { action: string };
    const source = { ...BASE };
    const metrics = createFakeMetrics();
    const lines: Line[] = [];
    const routing = compileRoutes(getConfig(source), source);
    for (const action of ['synchronize', 'labeled', 'edited']) {
      const event = loadPr(JSON.stringify({ ...opened, action }));
      const decision = decidePullRequest(event, routing, {
        log: (level, event, fields) => void lines.push({ level, event, fields: fields ?? {} }),
        deliveryId: DELIVERY,
        metrics,
      });
      expect(decision).toMatchObject({ kind: 'skip', reason: 'pr_action_ignored' });
    }
    expect(metrics.values.skippedTotal ?? 0).toBe(0);
    expect(lines.map((l) => l.level)).toEqual(['debug', 'debug', 'debug']);
    expect(lines.some((l) => l.event === 'pull_request_skipped')).toBe(false);
  });

  it('names the reviewer, not the pull request author, when IGNORE_AUTHORS is matched on a review', () => {
    // review.approved.json: opened by jane-doe, approved by sam-lee.
    expect(decidePr(reviewApprovedRaw, { IGNORE_AUTHORS: 'jane-doe' }, true).decision).toMatchObject({
      kind: 'post',
    });
    expect(decidePr(reviewApprovedRaw, { IGNORE_AUTHORS: 'sam-lee' }, true).decision).toMatchObject({
      kind: 'skip',
      reason: 'author_ignored',
    });
  });

  it('skips commented and unknown review states with pr_action_ignored', () => {
    const approved = JSON.parse(reviewApprovedRaw) as {
      pull_request: Record<string, unknown>;
      review: { state: string };
    };
    for (const state of ['commented', 'dismissed']) {
      const raw = JSON.stringify({
        ...approved,
        review: { ...approved.review, state },
      });
      expect(decidePr(raw, {}, true).decision).toMatchObject({
        kind: 'skip',
        reason: 'pr_action_ignored',
      });
    }
  });

  it('skips merged and closed pull requests when PR_ACTIONS allows opened only', () => {
    for (const fixture of [prMergedRaw, prClosedRaw]) {
      const { decision, lines } = decidePr(fixture, { PR_ACTIONS: 'opened' });
      expect(decision).toMatchObject({ kind: 'skip', reason: 'pr_action_ignored' });
      expect(lines[0]?.fields['patternsTried']).toEqual(['opened']);
    }
  });
});
