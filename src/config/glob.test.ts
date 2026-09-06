import { describe, expect, it } from 'vitest';
import { MAX_SUBJECT_BYTES, subjectTooLong } from '../core/bytes.ts';
import {
  GlobCompileError,
  MAX_PATTERN_LENGTH,
  compileGlob,
  compileGlobs,
} from './glob.ts';

/** The table of 15.2 (2927-2938), row for row. */
const TABLE: ReadonlyArray<[string, string, boolean, boolean]> = [
  ['main', 'main', true, false],
  ['main', 'Main', false, false],
  ['release/*', 'release/1.2', true, false],
  ['release/*', 'release/1.2/hotfix', false, false],
  ['release/**', 'release/1.2/hotfix', true, false],
  ['**', 'anything', true, false],
  ['*', 'main', true, false],
  ['*', 'feat/x', false, false],
  ['your-org/*', 'YOUR-ORG/api', true, true],
  ['feat/?', 'feat/a', true, false],
];

describe('compileGlob', () => {
  for (const [pattern, subject, expected, caseInsensitive] of TABLE) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} ${subject}`, () => {
      expect(compileGlob(pattern, { caseInsensitive })(subject)).toBe(expected);
    });
  }

  it('anchors on the full string', () => {
    expect(compileGlob('main')('main-backup')).toBe(false);
    expect(compileGlob('main')('release/main')).toBe(false);
  });

  it('matches ** against zero segments', () => {
    expect(compileGlob('release/**')('release')).toBe(true);
    expect(compileGlob('a/**/b')('a/b')).toBe(true);
    expect(compileGlob('a/**/b')('a/x/y/b')).toBe(true);
  });

  it('treats ? as exactly one character that is not a slash', () => {
    expect(compileGlob('feat/?')('feat/ab')).toBe(false);
    expect(compileGlob('a?b')('a/b')).toBe(false);
  });

  it('rejects a pattern longer than the length cap at compile time, by name', () => {
    const pattern = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    expect(() => compileGlob(pattern)).toThrow(GlobCompileError);
    try {
      compileGlob(pattern);
      expect.unreachable();
    } catch (err) {
      const error = err as GlobCompileError;
      expect(error.reason).toBe('pattern_too_long');
      expect(error.pattern).toBe(pattern);
      expect(error.message).toContain(String(MAX_PATTERN_LENGTH));
    }
    expect(() => compileGlob('a'.repeat(MAX_PATTERN_LENGTH))).not.toThrow();
  });

  it('rejects a pattern with more than two ** tokens at compile time', () => {
    expect(() => compileGlob('release/**/**/*')).not.toThrow();
    try {
      compileGlob('release/**/**/**/*');
      expect.unreachable();
    } catch (err) {
      expect((err as GlobCompileError).reason).toBe('too_many_globstars');
    }
  });

  it('rejects a subject longer than 512 bytes before matching', () => {
    const long = 'a'.repeat(MAX_SUBJECT_BYTES + 1);
    expect(subjectTooLong(long)).toBe(true);
    expect(compileGlob('**')(long)).toBe(false);
    expect(subjectTooLong('é'.repeat(300))).toBe(true);
    expect(subjectTooLong('a'.repeat(MAX_SUBJECT_BYTES))).toBe(false);
  });

  it('completes the pathological pattern/subject pair in under 10 ms', () => {
    const subject = 'a/'.repeat(200).slice(0, -1);
    const matcher = compileGlob('release/**/**/*');
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) expect(matcher(subject)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10);
    expect(() => compileGlob('release/**/**/**/*')).toThrow(GlobCompileError);
  });
});

describe('compileGlobs', () => {
  it('matches any pattern in the list and nothing for an empty list', () => {
    const match = compileGlobs(['main', 'release/*']);
    expect(match('main')).toBe(true);
    expect(match('release/1.2')).toBe(true);
    expect(match('feature/spike')).toBe(false);
    expect(compileGlobs([])('main')).toBe(false);
  });
});
