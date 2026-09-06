// src/render/table.ts
// PLATFORM-PURE. No hono, no node:*, no cloudflare:*, no Buffer.
// The markup primitives every table shares, so the commit, rollup and pull
// request builders cannot drift on a trailing <br> or an escaping rule.
import { escapeHtml } from '../core/escape.ts';
import { byteLength, contentBytes } from '../core/bytes.ts';
import { clipCodePoints, clipHtmlToBytes } from './truncate.ts';
import { sanitizeText } from '../security/sanitize.ts';
import { safeUrl } from '../security/safe-url.ts';
import { S } from './strings.ts';
import type { RefKind } from '../core/types.ts';

export interface RenderLimits {
  bodyMaxCodePoints: number; // COMMIT_BODY_MAX_CHARS
  contentMaxBytes: number; // CONTENT_MAX_BYTES
  webOrigin: string; // GITHUB_WEB_ORIGIN, e.g. https://github.com - safeUrl's allowlist
}

/**
 * Build-time switch, not a runtime knob (8.6). `colspan` is observed-working but
 * undocumented, and a stripped attribute still returns 201, so there is no signal
 * to key a config option on. Flip this to false to promote the two full-width
 * elements to block-level siblings outside the table.
 */
export const USE_COLSPAN = true;

/** Thrown when even the level-3 hard clip cannot fit CONTENT_MAX_BYTES. The caller
 *  drops the line with `error content_unrenderable { repo, sha }` (8.5). */
export class ContentUnrenderableError extends Error {
  constructor(bytes: number, limit: number) {
    super(`assembled content is ${bytes} bytes, over the ${limit} byte limit`);
    this.name = 'ContentUnrenderableError';
  }
}

export const UNAVAILABLE = 'N/A';

export function fitsContent(html: string, maxBytes: number): boolean {
  return contentBytes(html) <= maxBytes;
}

/** Binary-search the largest HTML prefix whose JSON envelope fits maxBytes. Budget 0 always fits. */
export function clipHtmlToContent(html: string, maxBytes: number): string {
  if (fitsContent(html, maxBytes)) return html;
  let lo = 0;
  let hi = byteLength(html);
  let best = clipHtmlToBytes(html, 0);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = clipHtmlToBytes(html, mid);
    if (fitsContent(candidate, maxBytes)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** A two-column label/value row. The trailing <br>\n is load-bearing. */
export const pair = (label: string, valueHtml: string): string =>
  `<tr><td nowrap><strong>${label}&nbsp;</strong></td><td>${valueHtml}<br>\n</td></tr>\n`;

/** A full-width row. Depends on colspan, which is observed-working, not documented. */
export const wide = (valueHtml: string): string =>
  `<tr><td colspan="2">${valueHtml}<br>\n</td></tr>\n`;

export const plain = (raw: string): string => escapeHtml(sanitizeText(raw));

/** Shared by every table, so a tag push is never labelled "Branch" in one of
 *  them and "Tag" in another. */
export const refLabel = (kind: RefKind): string => (kind === 'tag' ? S.tag : S.branch);

/**
 * Wraps the label/value rows plus the two full-width elements in whichever layout
 * USE_COLSPAN selects. Row order is identical in both: the label strip and the
 * body always follow the label/value rows. `useColspan` is a defaulted parameter
 * only so that the golden test can cover both layouts; no module ever passes it,
 * so 8.6 stays a build-time constant.
 */
export function assembleDocument(
  rowsHtml: string,
  labelHtml: string,
  bodyHtml: string,
  useColspan: boolean = USE_COLSPAN,
): string {
  if (useColspan) {
    return (
      '<div dir="ltr"><table dir="ltr" cellpadding="4">\n<tbody>\n' +
      rowsHtml +
      wide(`<strong>${labelHtml}</strong>`) +
      wide(bodyHtml) +
      '</tbody>\n</table></div>'
    );
  }
  // 8.6: every tag and attribute here is on the documented rich-text list. Block
  // elements are full-width by nature, so no attribute is needed.
  return (
    '<div dir="ltr">\n<table dir="ltr" cellpadding="4">\n<tbody>\n' +
    rowsHtml +
    '</tbody>\n</table>\n' +
    `<strong>${labelHtml}</strong><br>\n` +
    `<blockquote>${bodyHtml}<br>\n</blockquote>\n</div>`
  );
}

/**
 * Order is load-bearing and is specified in 8.2:
 *   sanitize -> truncate the SOURCE -> escape -> insert <br> -> collapse.
 * Truncating before escaping is what stops a slice landing mid-entity.
 */
export function renderMessageBody(raw: string, maxCodePoints: number): string {
  const cleaned = sanitizeText(raw).trimEnd();
  const clipped = clipCodePoints(cleaned, maxCodePoints);
  return escapeHtml(clipped)
    .replace(/\n/g, '<br>')
    .replace(/(?:<br>){3,}/g, '<br><br>');
}

/** The message, then the link on a line of its own. Either alone when the
 *  other is empty, so an empty message never starts with a bare <br>. */
export const withLinkBelow = (bodyHtml: string, linkHtml: string): string =>
  bodyHtml === '' || linkHtml === '' ? bodyHtml + linkHtml : `${bodyHtml}<br>${linkHtml}`;

export function anchor(url: string | null, text: string, origin: string): string {
  const safe = safeUrl(url, origin); // https only, origin must match; null otherwise
  if (safe) return ` <a href="${escapeHtml(safe)}">${escapeHtml(text)}</a>`;
  // A rejected URL is still shown, as inert escaped text with no <a> wrapper (8.4 E),
  // so a reader can see what was suppressed instead of the field silently vanishing.
  return url ? ` ${plain(url)}` : '';
}

/** Test-only surface: the 8.6 layout switch is a build-time constant, so the golden
 *  test for the non-default layout has no other way in. Not for production callers. */
export const __testOnly = { assembleDocument, USE_COLSPAN };
