import { describe, expect, it } from 'vitest';
import { isValidSegment, splitFullName } from './url.ts';

describe('isValidSegment', () => {
  it('rejects segments that start with ., _ or -', () => {
    for (const bad of ['.github', '_config', '-dash', '..foo', '...', '.', '..', '']) {
      expect(isValidSegment(bad)).toBe(false);
    }
  });

  it('accepts well-formed segments', () => {
    for (const good of ['a', 'A1', '0-x_y.z', 'my.repo-name_v2']) {
      expect(isValidSegment(good)).toBe(true);
    }
  });

  it('accepts a 100-character segment and rejects 101', () => {
    const ok = `a${'x'.repeat(99)}`;
    expect(ok).toHaveLength(100);
    expect(isValidSegment(ok)).toBe(true);
    expect(isValidSegment(`${ok}x`)).toBe(false);
  });
});

describe('splitFullName', () => {
  it('rejects dot segments, empty names and overlong segments', () => {
    expect(splitFullName('acme/.github')).toBeNull();
    expect(splitFullName('acme/_config')).toBeNull();
    expect(splitFullName('acme/-dash')).toBeNull();
    expect(splitFullName('a/..')).toBeNull();
    expect(splitFullName('a/.')).toBeNull();
    expect(splitFullName('')).toBeNull();
    expect(splitFullName(`a/${'x'.repeat(101)}`)).toBeNull();
  });
});
