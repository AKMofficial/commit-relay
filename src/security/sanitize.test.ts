import { describe, expect, it } from 'vitest';
import { sanitizeText } from './sanitize.ts';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

const RLO = cp(0x202e);
const BOOM = cp(0x1f4a5);

describe('sanitizeText', () => {
  it('strips C0 controls and U+007F but keeps the newline', () => {
    const controls = cp(0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f);
    expect(sanitizeText(`a${controls}b`)).toBe('ab');
    expect(sanitizeText('a\nb')).toBe('a\nb');
    expect(sanitizeText('a\tb')).toBe('ab');
  });

  it('strips C1 controls', () => {
    expect(sanitizeText(`a${cp(0x80, 0x85, 0x9f)}b`)).toBe('ab');
  });

  it('strips zero-width, bidi and BOM characters', () => {
    const invisible = cp(
      0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2066, 0x2067, 0x2068, 0x2069,
      0xfeff,
    );
    expect(sanitizeText(`x${invisible}y`)).toBe('xy');
  });

  it('strips U+202E from an author name, which is the display-spoof case', () => {
    expect(sanitizeText(`alice${RLO}`)).toBe('alice');
    expect(sanitizeText(`${RLO}ecila`)).toBe('ecila');
  });

  it('normalizes CRLF and a lone CR to LF', () => {
    expect(sanitizeText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(sanitizeText('a\r\r\nb')).toBe('a\n\nb');
  });

  it('normalizes to NFC', () => {
    const decomposed = `Jose${cp(0x301)}`;
    expect(Array.from(decomposed)).toHaveLength(5);
    expect(sanitizeText(decomposed)).toBe(`Jos${cp(0xe9)}`);
    expect(Array.from(sanitizeText(decomposed))).toHaveLength(4);
  });

  it('leaves an astral-plane character intact', () => {
    expect(sanitizeText(`boom ${BOOM}`)).toBe(`boom ${BOOM}`);
  });

  it('leaves ordinary markup characters alone, because escaping owns them', () => {
    expect(sanitizeText('<script>&"\'</script>')).toBe('<script>&"\'</script>');
  });

  it('is idempotent', () => {
    const messy = `a\r\n${RLO}b ${BOOM}Jose${cp(0x301)}`;
    expect(sanitizeText(sanitizeText(messy))).toBe(sanitizeText(messy));
  });

  it('strips newly covered invisible and bidi code points', () => {
    const chars = [
      cp(0x061c),
      cp(0x00ad),
      cp(0x2060),
      cp(0x180e),
      cp(0xfffb),
      cp(0xe0041),
    ];
    for (const ch of chars) {
      expect(sanitizeText(`a${ch}b`)).toBe('ab');
    }
  });

  it('leaves non-Latin scripts, combining marks and emoji untouched', () => {
    expect(sanitizeText('مرحبا')).toBe('مرحبا');
    expect(sanitizeText(`e${cp(0x0301)}`)).toBe(`é`);
    expect(sanitizeText(`ok ${cp(0x1f680)}`)).toBe(`ok ${cp(0x1f680)}`);
  });
});
