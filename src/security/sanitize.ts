// Applied to EVERY payload-derived string - commit message, author name,
// repository name, branch - not just the message (8.2, 12.1).

/** Cc (controls except LF, which normalize already preserved), Cf (format characters
 *  including bidi and zero-width), legacy Mongolian vowel separator, annotation
 *  characters, and the Unicode tag block used for invisible text. */
const STRIP = /(?!\n)[\p{Cc}\p{Cf}]|[᠎￹-￻]|[\u{E0000}-\u{E007F}]/gu;

/** CRLF and a lone CR normalize to LF BEFORE anything counts characters, so a
 *  Windows commit message is not clipped at a different point than a Unix one. */
export function sanitizeText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(STRIP, '').normalize('NFC');
}
