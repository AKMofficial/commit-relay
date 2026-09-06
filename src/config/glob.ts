/** Segment-wise glob matching (7.6). No regex translation: two nested single-star
 *  loops are linear in the subject and cannot backtrack exponentially like `.*`. */

import { subjectTooLong } from '../core/bytes.ts';
import type { GlobMatcher } from '../core/types.ts';

export const MAX_PATTERN_LENGTH = 200;
const MAX_GLOBSTARS = 2;


export type GlobCompileReason = 'pattern_too_long' | 'too_many_globstars' | 'pattern_empty';

/** Thrown at boot, never at match time: patterns come from config only. */
export class GlobCompileError extends Error {
  readonly pattern: string;
  readonly reason: GlobCompileReason;

  constructor(pattern: string, reason: GlobCompileReason, message: string) {
    super(message);
    this.name = 'GlobCompileError';
    this.pattern = pattern;
    this.reason = reason;
  }
}

export interface GlobOptions {
  caseInsensitive?: boolean;
}

/** A UTF-8 byte is never shorter than a UTF-16 code unit, so the cheap length
 *  test rejects the huge cases before anything is encoded. */

/** Single-star wildcard matching over any alphabet. `star`/`mark` remember the
 *  last star so a mismatch resumes there instead of recursing. */
function wildcardMatch<T>(
  pattern: ArrayLike<T>,
  subject: ArrayLike<T>,
  star: T,
  eq: (p: T, s: T) => boolean,
): boolean {
  let p = 0;
  let s = 0;
  let starAt = -1;
  let mark = 0;

  while (s < subject.length) {
    if (p < pattern.length && pattern[p] === star) {
      starAt = p;
      p += 1;
      mark = s;
      continue;
    }
    if (p < pattern.length && eq(pattern[p] as T, subject[s] as T)) {
      p += 1;
      s += 1;
      continue;
    }
    if (starAt < 0) return false;
    mark += 1;
    s = mark;
    p = starAt + 1;
  }

  while (p < pattern.length && pattern[p] === star) p += 1;
  return p === pattern.length;
}

/** `*` and `?` inside one segment. */
function matchSegment(pattern: string, subject: string): boolean {
  return wildcardMatch(pattern, subject, '*', (p, s) => p === '?' || p === s);
}

/** The same algorithm one level up, with `**` as the star and whole segments as
 *  the alphabet, so `**` matches zero or more segments. */
function matchSegments(pattern: readonly string[], subject: readonly string[]): boolean {
  return wildcardMatch(pattern, subject, '**', matchSegment);
}

/** The returned matcher is total: an oversized subject is `false` rather than a
 *  throw, because the subject is payload-controlled and a throw is a DoS lever. */
function compileGlobPattern(pattern: string, options: GlobOptions = {}): readonly string[] {
  if (pattern.length === 0) {
    throw new GlobCompileError(pattern, 'pattern_empty', 'glob pattern is empty.');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new GlobCompileError(
      pattern,
      'pattern_too_long',
      `glob pattern is ${pattern.length} characters, above the ${MAX_PATTERN_LENGTH}-character cap.`,
    );
  }

  const caseInsensitive = options.caseInsensitive === true;
  const segments = (caseInsensitive ? pattern.toLowerCase() : pattern).split('/');
  const globstars = segments.filter((seg) => seg === '**').length;
  if (globstars > MAX_GLOBSTARS) {
    throw new GlobCompileError(
      pattern,
      'too_many_globstars',
      `glob pattern has ${globstars} "**" tokens, above the limit of ${MAX_GLOBSTARS}.`,
    );
  }

  return segments;
}

export function compileGlob(pattern: string, options: GlobOptions = {}): GlobMatcher {
  return compileGlobs([pattern], options);
}

export function compileGlobs(patterns: readonly string[], options: GlobOptions = {}): GlobMatcher {
  const compiled = patterns.map((pattern) => compileGlobPattern(pattern, options));
  const caseInsensitive = options.caseInsensitive === true;

  return (subject: string): boolean => {
    if (subjectTooLong(subject)) return false;
    const value = caseInsensitive ? subject.toLowerCase() : subject;
    const subjectSegments = value.split('/');
    return compiled.some((segments) => matchSegments(segments, subjectSegments));
  };
}
