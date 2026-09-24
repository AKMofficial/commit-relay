// Applied to EVERY payload-derived string - commit message, author name,
// repository name, branch - not just the message (8.2, 12.1).

/** Cc (controls except LF, which normalize already preserved), Cf (format characters
 *  including bidi, zero-width and the tag block), every default-ignorable code point
 *  (Hangul fillers, variation selectors, the Mongolian vowel separator, annotation
 *  characters), and the braille blank: everything that renders as nothing. */
const STRIP = /(?!\n)[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** CRLF, a lone CR and U+2028/U+2029 normalize to LF BEFORE anything counts characters, so a
 *  Windows commit message is not clipped at a different point than a Unix one. */
export function sanitizeText(s: string): string {
  return s.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(STRIP, '').normalize('NFC');
}
