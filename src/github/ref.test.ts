import { describe, expect, it } from 'vitest';
import { classifyRef } from './ref.ts';

describe('classifyRef', () => {
  it('classifies branch refs, including names that contain a slash', () => {
    expect(classifyRef('refs/heads/main')).toEqual({ kind: 'branch', name: 'main' });
    expect(classifyRef('refs/heads/release/2.0')).toEqual({ kind: 'branch', name: 'release/2.0' });
  });

  it('classifies tag refs', () => {
    expect(classifyRef('refs/tags/v0.1.0')).toEqual({ kind: 'tag', name: 'v0.1.0' });
  });

  it('never hands the branch list a refs/tags/ string', () => {
    const parsed = classifyRef('refs/tags/v0.1.0');
    expect(parsed.kind).toBe('tag');
    expect(JSON.stringify(parsed)).not.toContain('refs/');
  });

  it('classifies anything else as unknown', () => {
    for (const ref of ['refs/pull/42/merge', 'refs/notes/commits', 'main', '', 'refs/heads/']) {
      expect(classifyRef(ref)).toEqual({ kind: 'unknown' });
    }
  });

  it('rejects a ref over the 512-byte subject cap', () => {
    expect(classifyRef(`refs/heads/${'a'.repeat(600)}`)).toEqual({ kind: 'too_long' });
    expect(classifyRef(`refs/heads/${'é'.repeat(300)}`)).toEqual({ kind: 'too_long' });
  });
});
