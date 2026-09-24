// src/render/message.ts
// PLATFORM-PURE. No hono, no node:*, no cloudflare:*, no Buffer.
import { byteLength, contentBytes } from '../core/bytes.ts';
import { clipHtmlToBytes } from './truncate.ts';
import { sanitizeText } from '../security/sanitize.ts';
import { S } from './strings.ts';
import type { RefKind, RollupKind } from '../core/types.ts';
import {
  ContentUnrenderableError,
  UNAVAILABLE,
  anchor,
  assembleDocument,
  fitsContent,
  pair,
  plain,
  refLabel,
  renderMessageBody,
  withLinkBelow,
  type RenderLimits,
} from './table.ts';

export interface CommitView {
  repoFullName: string;
  refKind: RefKind;
  refName: string;
  author: string;
  fileCount: number | null;
  additions: number | null;
  deletions: number | null;
  message: string;
  commitUrl: string | null;
}

export function buildCommitTable(v: CommitView, lim: RenderLimits): string {
  const changes =
    v.additions === null || v.deletions === null
      ? UNAVAILABLE
      : `+${v.additions} / -${v.deletions}`;

  // Payload-derived (added + removed + modified), so it is only ever null on a
  // shape surprise. files[] is never read: the stats call sends ?per_page=1.
  const files = v.fileCount === null ? UNAVAILABLE : `${v.fileCount}`;

  const rows =
    pair(S.repository, plain(v.repoFullName)) +
    pair(refLabel(v.refKind), plain(v.refName)) +
    pair(S.author, plain(v.author)) +
    pair(S.files, files) +
    pair(S.changes, changes);

  const frame = (bodyHtml: string): string => assembleDocument(rows, S.commitMessage, bodyHtml);
  const link = anchor(v.commitUrl, S.viewCommit, lim.webOrigin).trim();

  // 1. Full body, then on its own line the link to the commit: the one
  //    clickable thing in the message, as the rollup already has. An empty
  //    message leaves the link alone in the cell.
  const body = renderMessageBody(v.message, lim.bodyMaxCodePoints);
  const full = frame(withLinkBelow(body, link));
  if (fitsContent(full, lim.contentMaxBytes)) return full;

  // 2. Subject line plus the same link.
  const subject = renderMessageBody(
    sanitizeText(v.message).split('\n', 1)[0] ?? '',
    lim.bodyMaxCodePoints,
  );
  const short = frame(withLinkBelow(subject, link));
  if (fitsContent(short, lim.contentMaxBytes)) return short;

  // 3. Hard clip. A single-line 20 KB subject is legal in git, so level 2
  //    is not a guarantee. Search by envelope size so JSON quoting cannot overshoot.
  let lo = 0;
  let hi = byteLength(subject);
  let clipped: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = frame(withLinkBelow(clipHtmlToBytes(subject, mid), link));
    if (fitsContent(candidate, lim.contentMaxBytes)) {
      clipped = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (clipped !== null) return clipped;

  const bare = frame(link);
  if (!fitsContent(bare, lim.contentMaxBytes)) {
    throw new ContentUnrenderableError(contentBytes(bare), lim.contentMaxBytes);
  }
  return bare;
}

/** Why a rollup was sent. Selects the row-5 label and nothing else. */
export interface RollupView {
  kind: RollupKind;
  repoFullName: string;
  refKind: RefKind;
  refName: string;
  fileCount: number | null;
  authors: string[];
  compareUrl: string | null;
  /** The pushed head. A force push links here instead of the comparison. */
  headCommitUrl: string | null;
}

/** Exhaustive by type: a new RollupKind will not compile without a string. */
const ROLLUP_LABEL: Record<RollupKind, string> = {
  cap: S.rollupCap,
  branch_create: S.rollupBranchCreate,
  forced: S.rollupForced,
};

export function buildRollupTable(r: RollupView, lim: RenderLimits): string {
  // A force push has no meaningful before...after: after a history rewrite the
  // comparison shares no commits (GitHub shows "no common ancestor"), commits[]
  // lists the whole new history, and the old tip may hold what the rewrite purged.
  // The webhook carries no parent SHAs to tell a rewrite from a rebase, so every
  // force push links the new head and reports no file count.
  const forced = r.kind === 'forced';
  const link = (
    forced
      ? anchor(r.headCommitUrl, S.viewLatestCommit, lim.webOrigin)
      : anchor(r.compareUrl, S.viewComparison, lim.webOrigin)
  ).trim();
  const fileCount = forced ? null : r.fileCount;

  // Changes is always N/A here: the compare endpoint's commits[] carries
  // no per-commit stats, and fetching them is the subrequest cost the cap avoids.
  const rows =
    pair(S.repository, plain(r.repoFullName)) +
    pair(refLabel(r.refKind), plain(r.refName)) +
    pair(S.files, fileCount === null ? UNAVAILABLE : `${fileCount}`) +
    pair(S.changes, UNAVAILABLE);

  const distinctAuthors = [...new Set(r.authors.map((name) => plain(name)))];
  const authors =
    distinctAuthors.length <= 5
      ? distinctAuthors.join(', ')
      : `${distinctAuthors.slice(0, 5).join(', ')}, +${distinctAuthors.length - 5} more`;

  let footer = withLinkBelow(`${S.commitsNotShown}<br>${S.authors}: ${authors}`, link);
  let html = assembleDocument(
    rows,
    // Besides the force-push link and Files row above, the only per-kind
    // difference. No free-text label ever reaches the renderer.
    ROLLUP_LABEL[r.kind],
    // No count of any kind: nothing posted individually, and commits[] is capped at
    // 2048 with an oversized payload never delivered, so any figure here is a floor.
    footer,
  );

  if (!fitsContent(html, lim.contentMaxBytes)) {
    footer = withLinkBelow(S.commitsNotShown, link);
    html = assembleDocument(rows, ROLLUP_LABEL[r.kind], footer);
  }

  // No third level: clipping the assembled document would leave tags unclosed,
  // and 8.5 says drop rather than post malformed HTML.
  if (!fitsContent(html, lim.contentMaxBytes)) {
    throw new ContentUnrenderableError(contentBytes(html), lim.contentMaxBytes);
  }

  return html;
}

