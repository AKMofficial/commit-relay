// src/render/truncate.ts
import { byteLength } from '../core/bytes.ts';

/** Clip by code point, never by UTF-16 code unit, so a surrogate pair is never split. */
export function clipCodePoints(s: string, max: number): string {
  let count = 0;
  let i = 0;
  for (const ch of s) {
    count += 1;
    i += ch.length;
    if (count === max) break;
  }
  if (count < max || i >= s.length) return s;

  const hard = s.slice(0, i);
  const chars = Array.from(hard);
  let j = chars.length;
  while (j > 0 && !/\s/.test(chars[j - 1]!)) j -= 1;
  while (j > 0 && /\s/.test(chars[j - 1]!)) j -= 1;
  const trimmed = chars.slice(0, j).join('');
  const keep = trimmed.length >= Math.ceil(max / 2) ? trimmed : hard;
  return `${keep} …`;
}

/** Clip already-escaped HTML on token boundaries: never inside an entity or a <br>. */
export function clipHtmlToBytes(html: string, budget: number): string {
  if (byteLength(html) <= budget) return html;
  const tokens = html.match(/&[a-zA-Z]+;|&#\d+;|<br>|[\s\S]/gu) ?? [];
  let out = '';
  let used = 0;
  for (const t of tokens) {
    const n = byteLength(t);
    if (used + n > budget) break;
    out += t;
    used += n;
  }
  return out;
}
