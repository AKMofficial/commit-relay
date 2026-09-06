import { describe, expect, it } from 'vitest';
import { byteLength } from '../core/bytes.ts';
import { clipCodePoints, clipHtmlToBytes } from './truncate.ts';

const EMOJI = '\u{1F4A5}';

describe('byteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('é')).toBe(2);
    expect(byteLength(EMOJI)).toBe(4);
    expect(EMOJI.length).toBe(2);
  });
});

describe('clipCodePoints', () => {
  it('returns the input untouched when it is already within the limit', () => {
    expect(clipCodePoints('hello', 5)).toBe('hello');
    expect(clipCodePoints(`${EMOJI}${EMOJI}`, 2)).toBe(`${EMOJI}${EMOJI}`);
  });

  it('counts code points, so an astral string is not clipped at half its length', () => {
    const s = EMOJI.repeat(10);
    expect(clipCodePoints(s, 10)).toBe(s);
  });

  it('never splits a surrogate pair', () => {
    const clipped = clipCodePoints(`${EMOJI.repeat(5)} tail`, 3);
    for (const unit of clipped) {
      const code = unit.codePointAt(0) ?? 0;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it('cuts back to a whitespace boundary and appends an ellipsis', () => {
    expect(clipCodePoints('alpha beta gamma', 13)).toBe('alpha beta …');
  });

  it('hard-slices when the only whitespace is near the start', () => {
    const input = ` ${'x'.repeat(5000)}`;
    const clipped = clipCodePoints(input, 100);
    expect(clipped.endsWith(' …')).toBe(true);
    expect(clipped).not.toBe(' …');
    expect(Array.from(clipped.slice(0, -2)).length).toBeGreaterThanOrEqual(90);
  });

  it('clips a 3M-character input in under 200 ms without exceeding max plus suffix', () => {
    const input = 'a'.repeat(3_000_000);
    const start = performance.now();
    const result = clipCodePoints(input, 2000);
    expect(performance.now() - start).toBeLessThan(200);
    expect(Array.from(result.replace(/ …$/, '')).length).toBeLessThanOrEqual(2000);
    expect(result.endsWith(' …')).toBe(true);
  });

  it('completes a long whitespace run in under 50 ms', () => {
    const input = `${' '.repeat(1997)}x y${'z'.repeat(5000)}`;
    const start = performance.now();
    clipCodePoints(input, 2000);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('never produces a lone surrogate on emoji input', () => {
    const result = clipCodePoints('😀'.repeat(3000), 2000);
    for (const c of result) {
      const cp = c.codePointAt(0)!;
      expect(cp < 0xd800 || cp > 0xdfff || c.length === 2).toBe(true);
    }
  });
});

describe('clipHtmlToBytes', () => {
  it('returns the input untouched when it already fits', () => {
    expect(clipHtmlToBytes('a&amp;b', 100)).toBe('a&amp;b');
  });

  it('never splits a named or numeric entity', () => {
    expect(clipHtmlToBytes('ab&amp;cd', 4)).toBe('ab');
    expect(clipHtmlToBytes('ab&amp;cd', 7)).toBe('ab&amp;');
    expect(clipHtmlToBytes('ab&#39;cd', 7)).toBe('ab&#39;');
  });

  it('never splits a <br>', () => {
    expect(clipHtmlToBytes('ab<br>cd', 5)).toBe('ab');
    expect(clipHtmlToBytes('ab<br>cd', 6)).toBe('ab<br>');
  });

  it('never splits a multi-byte character', () => {
    const out = clipHtmlToBytes(`x${EMOJI}y`, 3);
    expect(out).toBe('x');
    expect(byteLength(out)).toBeLessThanOrEqual(3);
  });

  it('holds the byte budget on every prefix it can produce', () => {
    const html = 'a&amp;b<br>c&#39;d\u{1F4A5}e';
    for (let budget = 0; budget <= byteLength(html) + 2; budget++) {
      expect(byteLength(clipHtmlToBytes(html, budget))).toBeLessThanOrEqual(budget);
    }
  });

  it('never emits a lone surrogate on astral input at many budgets', () => {
    const html = `${EMOJI.repeat(40)}<br>${EMOJI}`;
    for (let budget = 1; budget <= byteLength(html); budget++) {
      const out = clipHtmlToBytes(html, budget);
      expect(out.isWellFormed()).toBe(true);
    }
  });
});
