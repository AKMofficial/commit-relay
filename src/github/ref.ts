import type { ParsedRef } from '../core/types.ts';
import { subjectTooLong } from '../core/bytes.ts';

/** A branch name may itself contain `/`, so the literal 11-character prefix is
 *  sliced off rather than split on `/`. */
const HEADS_PREFIX = 'refs/heads/';
const TAGS_PREFIX = 'refs/tags/';

export type RefClassification = ParsedRef | { kind: 'unknown' } | { kind: 'too_long' };

export function classifyRef(ref: string): RefClassification {
  if (subjectTooLong(ref)) return { kind: 'too_long' };
  if (ref.startsWith(HEADS_PREFIX)) {
    const name = ref.slice(HEADS_PREFIX.length);
    return name.length === 0 ? { kind: 'unknown' } : { kind: 'branch', name };
  }
  if (ref.startsWith(TAGS_PREFIX)) {
    const name = ref.slice(TAGS_PREFIX.length);
    return name.length === 0 ? { kind: 'unknown' } : { kind: 'tag', name };
  }
  return { kind: 'unknown' };
}
