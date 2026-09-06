import { describe, expect, it } from 'vitest';
import { safeUrl } from './safe-url.ts';

const ORIGIN = 'https://github.com';

describe('safeUrl', () => {
  it('accepts an https URL on the configured origin and returns it normalised', () => {
    expect(safeUrl('https://github.com/your-org/your-repo/commit/abc1234', ORIGIN)).toBe(
      'https://github.com/your-org/your-repo/commit/abc1234',
    );
    expect(safeUrl('https://github.com', ORIGIN)).toBe('https://github.com/');
  });

  it('accepts a self-hosted origin when that is what is configured', () => {
    expect(safeUrl('https://ghe.example.com/a/b', 'https://ghe.example.com')).toBe(
      'https://ghe.example.com/a/b',
    );
    expect(safeUrl('https://github.com/a/b', 'https://ghe.example.com')).toBeNull();
  });

  it('rejects every scheme but https', () => {
    expect(safeUrl('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(safeUrl('data:text/html,<script>alert(1)</script>', ORIGIN)).toBeNull();
    expect(safeUrl('http://github.com/a/b', ORIGIN)).toBeNull();
    expect(safeUrl('ftp://github.com/a/b', ORIGIN)).toBeNull();
  });

  it('rejects userinfo, which reads as the allowed host but resolves elsewhere', () => {
    expect(safeUrl('https://github.com@evil.example/x', ORIGIN)).toBeNull();
    expect(safeUrl('https://github.com:token@github.com/a/b', ORIGIN)).toBeNull();
  });

  it('rejects a different host, a subdomain, and a different port', () => {
    expect(safeUrl('https://evil.example/your-org/your-repo', ORIGIN)).toBeNull();
    expect(safeUrl('https://github.com.evil.example/a', ORIGIN)).toBeNull();
    expect(safeUrl('https://raw.github.com/a', ORIGIN)).toBeNull();
    expect(safeUrl('https://github.com:8443/a', ORIGIN)).toBeNull();
  });

  it('rejects a null, empty, or unparseable value rather than throwing', () => {
    expect(safeUrl(null, ORIGIN)).toBeNull();
    expect(safeUrl(undefined, ORIGIN)).toBeNull();
    expect(safeUrl('', ORIGIN)).toBeNull();
    expect(safeUrl('/your-org/your-repo', ORIGIN)).toBeNull();
    expect(safeUrl('not a url', ORIGIN)).toBeNull();
  });

  it('rejects everything when the configured origin is itself unparseable', () => {
    expect(safeUrl('https://github.com/a', 'nonsense')).toBeNull();
  });
});
