/** Sanitizing and truncation happen here, at ingest (9.4), so no downstream stage
 *  ever holds an untruncated string. */

import type { LogFn } from '../obs/log.ts';
import type { NormalizedCommit, PullRequestEvent, PushEvent } from '../core/types.ts';
import { clipCodePoints } from '../render/truncate.ts';
import { sanitizeText } from '../security/sanitize.ts';
import { isValidSha, splitFullName } from './url.ts';
import { z } from 'zod';
import {
  COMMITS_ARRAY_CAP,
  pullRequestPayload,
  pullRequestReviewPayload,
  pushPayload,
  type PullRequestPayload,
  type PullRequestReviewPayload,
  type PushPayload,
} from './payload-schema.ts';

export { COMMITS_ARRAY_CAP } from './payload-schema.ts';

export interface ParseLimits {
  commitBodyMaxChars: number;
  /** Makes a post-verification warning traceable to its delivery (14.1). */
  deliveryId?: string;
}

export interface ParseIssue {
  path: string;
  message: string;
}

export type ParseResult = { ok: true; event: PushEvent } | { ok: false; issues: ParseIssue[] };

export type PullRequestParseResult =
  | { ok: true; event: PullRequestEvent }
  | { ok: false; issues: ParseIssue[] };

/** zod can throw on a hostile shape before it ever reports an issue, so every
 *  parse goes through here and a throw becomes the same 422 as a bad shape. */
function safeParse<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; data: T } | { ok: false; issues: ParseIssue[] } {
  let parsed;
  try {
    parsed = schema.safeParse(raw);
  } catch {
    return { ok: false, issues: [{ path: 'payload', message: 'could not be validated.' }] };
  }
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues
      .map((issue) => ({ path: issue.path.join('.') || 'payload', message: issue.message }))
      .slice(0, 20),
  };
}

function clipCodePointUnits(s: string, max: number): string {
  let count = 0;
  let i = 0;
  for (const ch of s) {
    count += 1;
    i += ch.length;
    if (count === max) break;
  }
  if (count < max || i >= s.length) return s;
  return s.slice(0, i);
}

function preclip(s: string, maxCodePoints: number): string {
  const maxUnits = 4 * maxCodePoints;
  if (s.length <= maxUnits) return s;
  let units = 0;
  let i = 0;
  for (const ch of s) {
    if (units + ch.length > maxUnits) break;
    units += ch.length;
    i += ch.length;
  }
  return s.slice(0, i);
}

function capUnits(s: string, max: number): string {
  return clipCodePointUnits(s, max);
}

/** A ref routes by name, so one the sanitizer would rewrite (`ma<U+200B>in`
 *  becoming `main`) is blanked instead: it then classifies as no ref at all
 *  rather than matching an allowlist written for the branch it imitates. NFC is
 *  applied first so a decomposed (NFD) name, common for refs made on macOS, still routes
 *  and matches an allowlist written in composed form. Emoji glue is allowed because it
 *  cannot turn a plain name into a look-alike: a presentation selector after an emoji
 *  (`fix/❤️`) or in a keycap (`1️⃣`), and a joiner between two emoji (`feat/👩‍💻`). */
function routableRef(s: string, max: number): string {
  const nfc = s.normalize('NFC');
  return sanitizeText(nfc) === nfc.replace(EMOJI_GLUE, '') ? capUnits(nfc, max) : '';
}

const EMOJI_GLUE =
  /(?<=\p{Extended_Pictographic})[\uFE0E\uFE0F]|(?<=[0-9#*])\uFE0F(?=\u20E3)|(?<=\p{Extended_Pictographic}[\uFE0F\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic})/gu;

/** Only the count is reported, so the union stops growing here; a push that
 *  reaches it reports no count rather than a false exact one. */
export const CHANGED_PATHS_CAP = 50_000;

function resolveRepo(
  repository: PushPayload['repository'],
  log: LogFn,
  deliveryId: string | undefined,
): { repoFullName: string; owner: string; repo: string } | null {
  const repoFullName = sanitizeText(repository.full_name);
  const repoParts = splitFullName(repoFullName);
  if (repoParts === null) return null;

  const ownerLogin = capUnits(sanitizeText(repository.owner.login), 512);
  const repoName = capUnits(sanitizeText(repository.name), 512);
  if (ownerLogin !== repoParts.owner || repoName !== repoParts.repo) {
    log('warn', 'repo_name_mismatch', {
      repo: repoFullName,
      ownerLogin,
      repoName,
      deliveryId,
    });
  }

  return { repoFullName, owner: repoParts.owner, repo: repoParts.repo };
}

export function parsePush(raw: unknown, limits: ParseLimits, log: LogFn): ParseResult {
  const parsed = safeParse(pushPayload, raw);
  if (!parsed.ok) return parsed;

  const payload = parsed.data;
  const issues: ParseIssue[] = [];

  const repo = resolveRepo(payload.repository, log, limits.deliveryId);
  if (repo === null) {
    issues.push({ path: 'repository.full_name', message: 'is not a valid owner/name pair.' });
  }

  const commits: NormalizedCommit[] = [];
  const changedPaths = new Set<string>();
  payload.commits.forEach((commit, index) => {
    for (const paths of [commit.added, commit.removed, commit.modified]) {
      for (const path of paths) {
        if (changedPaths.size >= CHANGED_PATHS_CAP) break;
        changedPaths.add(path);
      }
    }
    const id = sanitizeText(commit.id);
    if (!isValidSha(id)) {
      issues.push({ path: `commits[${index}].id`, message: 'is not a 40-character hex commit id.' });
      return;
    }
    commits.push({
      id,
      message: clipCodePoints(
        sanitizeText(preclip(commit.message, limits.commitBodyMaxChars)),
        limits.commitBodyMaxChars,
      ),
      url: capUnits(sanitizeText(commit.url), 2048),
      distinct: commit.distinct,
      authorName: capUnits(sanitizeText(commit.author.name), 512),
      authorEmail: capUnits(sanitizeText(commit.author.email), 512),
      authorUsername:
        commit.author.username === undefined || commit.author.username === null
          ? null
          : capUnits(sanitizeText(commit.author.username), 512),
      fileCount: commit.added.length + commit.removed.length + commit.modified.length,
    });
  });

  if (issues.length > 0 || repo === null) return { ok: false, issues };

  if (payload.commits.length >= COMMITS_ARRAY_CAP) {
    log('warn', 'payload_possibly_truncated', {
      repo: repo.repoFullName,
      commits: payload.commits.length,
      cap: COMMITS_ARRAY_CAP,
      deliveryId: limits.deliveryId,
    });
  }

  return {
    ok: true,
    event: {
      ref: routableRef(payload.ref, 2048),
      before: payload.before,
      after: payload.after,
      created: payload.created,
      deleted: payload.deleted,
      forced: payload.forced,
      compare: capUnits(sanitizeText(payload.compare), 2048),
      repoFullName: repo.repoFullName,
      repoOwner: repo.owner,
      repoName: repo.repo,
      repoHtmlUrl: capUnits(sanitizeText(payload.repository.html_url), 2048),
      senderLogin: capUnits(sanitizeText(payload.sender.login), 2048),
      senderType: capUnits(sanitizeText(payload.sender.type), 2048),
      commits,
      changedPathCount: changedPaths.size >= CHANGED_PATHS_CAP ? null : changedPaths.size,
    },
  };
}

/**
 * Both pull-request events share this shape; only the `review` block differs, and
 * a review's shorter pull-request representation simply carries no line counts,
 * which render as `N/A`. Taking `review` as an argument rather than sniffing the
 * payload keeps both callers fully typed.
 */
type ReviewBlock = PullRequestReviewPayload['review'];

function buildPullRequestEvent(
  payload: PullRequestPayload,
  review: ReviewBlock | undefined,
  limits: ParseLimits,
  log: LogFn,
): PullRequestParseResult {
  const pr = payload.pull_request;

  const repo = resolveRepo(payload.repository, log, limits.deliveryId);
  if (repo === null) {
    return {
      ok: false,
      issues: [{ path: 'repository.full_name', message: 'is not a valid owner/name pair.' }],
    };
  }

  return {
    ok: true,
    event: {
      action: capUnits(sanitizeText(payload.action), 512),
      merged: pr.merged === true,
      draft: pr.draft === true,
      number: pr.number,
      // The title is the message body of this table, so it takes the same
      // code-point budget a commit message does.
      title: clipCodePoints(
        sanitizeText(preclip(pr.title, limits.commitBodyMaxChars)),
        limits.commitBodyMaxChars,
      ),
      // A review deep-links to the review itself; everything else to the PR.
      htmlUrl: capUnits(sanitizeText(review?.html_url ?? pr.html_url), 2048),
      headRef: capUnits(sanitizeText(pr.head.ref), 512),
      headSha: capUnits(sanitizeText(pr.head.sha), 512),
      baseRef: routableRef(pr.base.ref, 512),
      // On a review the Author row names who reviewed, not who opened the pull
      // request, and that is also who IGNORE_AUTHORS is matched against.
      author: capUnits(sanitizeText(review?.user.login ?? pr.user.login), 512),
      fileCount: pr.changed_files ?? null,
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
      repoFullName: repo.repoFullName,
      ...(review === undefined
        ? {}
        : { reviewState: capUnits(sanitizeText(review.state), 512), reviewId: review.id }),
    },
  };
}

export function parsePullRequest(
  raw: unknown,
  limits: ParseLimits,
  log: LogFn,
): PullRequestParseResult {
  const parsed = safeParse(pullRequestPayload, raw);
  if (!parsed.ok) return parsed;
  return buildPullRequestEvent(parsed.data, undefined, limits, log);
}

export function parsePullRequestReview(
  raw: unknown,
  limits: ParseLimits,
  log: LogFn,
): PullRequestParseResult {
  const parsed = safeParse(pullRequestReviewPayload, raw);
  if (!parsed.ok) return parsed;
  return buildPullRequestEvent(parsed.data, parsed.data.review, limits, log);
}
