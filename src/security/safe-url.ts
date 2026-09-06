// escapeHtml neutralises quote-breaking but says nothing about schemes, so every
// value entering an href passes through here first (12.1).

/**
 * https: only, origin must equal the configured GitHub web origin, and userinfo is
 * rejected outright: `https://github.com@evil.example/x` reads as github.com.
 */
export function safeUrl(url: string | null | undefined, origin: string): string | null {
  if (!url) return null;

  let parsed: URL;
  let allowed: URL;
  try {
    parsed = new URL(url);
    allowed = new URL(origin);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.origin !== allowed.origin) return null;
  return parsed.toString();
}
