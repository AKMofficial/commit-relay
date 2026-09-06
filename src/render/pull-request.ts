// src/render/pull-request.ts
// PLATFORM-PURE. No hono, no node:*, no cloudflare:*, no Buffer.
import { contentBytes } from '../core/bytes.ts';
import { escapeHtml } from '../core/escape.ts';
import { S } from './strings.ts';
import type { PullRequestJob, PullRequestKind } from '../core/types.ts';
import {
  ContentUnrenderableError,
  UNAVAILABLE,
  anchor,
  assembleDocument,
  fitsContent,
  pair,
  plain,
  renderMessageBody,
  withLinkBelow,
  type RenderLimits,
} from './table.ts';

export interface PullRequestView
  extends Pick<
    PullRequestJob,
    | 'kind'
    | 'repoFullName'
    | 'headRef'
    | 'number'
    | 'author'
    | 'fileCount'
    | 'additions'
    | 'deletions'
    | 'title'
    | 'htmlUrl'
  > {
  baseRef: string;
}

/** Exhaustive by type: a new PullRequestKind will not compile without a word. */
const KIND_WORD: Record<PullRequestKind, string> = {
  opened: S.prOpened,
  merged: S.prMerged,
  closed: S.prClosed,
  reopened: S.prReopened,
  ready_for_review: S.prReadyForReview,
  review_approved: S.prReviewApproved,
  review_changes_requested: S.prReviewChangesRequested,
};

/**
 * The same five label/value rows as a commit table, so the two read as one
 * family, with the branch row carrying `head -> base` because a pull request is
 * about a pair of branches rather than one. The line counts ride along in the
 * webhook payload, so unlike a commit this costs no GitHub call.
 */
export function buildPullRequestTable(v: PullRequestView, lim: RenderLimits): string {
  const changes =
    v.additions === null || v.deletions === null
      ? UNAVAILABLE
      : `+${v.additions} / -${v.deletions}`;

  const files = v.fileCount === null ? UNAVAILABLE : `${v.fileCount}`;

  const rows =
    pair(S.repository, plain(v.repoFullName)) +
    pair(S.branch, `${plain(v.headRef)}${S.branchArrow}${plain(v.baseRef)}`) +
    pair(S.author, plain(v.author)) +
    pair(S.files, files) +
    pair(S.changes, changes);

  // The number is a payload integer, never a string, so it cannot carry markup.
  const label = escapeHtml(`${S.pullRequest} #${v.number} ${KIND_WORD[v.kind]}`);
  const frame = (bodyHtml: string): string => assembleDocument(rows, label, bodyHtml);

  const link = anchor(v.htmlUrl, S.viewPullRequest, lim.webOrigin).trim();

  // 1. The title, then the link on its own line, as the commit table does.
  const title = renderMessageBody(v.title, lim.bodyMaxCodePoints);
  const full = frame(withLinkBelow(title, link));
  if (fitsContent(full, lim.contentMaxBytes)) return full;

  // 2. The link alone: a title long enough to overflow is a title the reader is
  //    better served opening on GitHub.
  const bare = frame(link);
  if (fitsContent(bare, lim.contentMaxBytes)) return bare;

  // No third level: the commit ladder clips the subject before framing it, but
  // here only the frame is left, and clipping it would post unclosed tags (8.5).
  throw new ContentUnrenderableError(contentBytes(bare), lim.contentMaxBytes);
}
