export interface LinesUrlParts {
  accountId: string;
  chatbotKey: string;
  bucketId: string;
  chatId: string;
}

/** Basecamp shows the `3.basecamp.com` form in the UI and the
 *  `3.basecampapi.com` form in API responses; both are accepted. */
const HOSTS = new Set(['3.basecamp.com', '3.basecampapi.com']);

const PATH =
  /^\/(\d{1,20})\/integrations\/([^/]+)\/buckets\/(\d{1,20})\/chats\/(\d{1,20})\/lines(?:\.json)?$/;

export function parseLinesUrl(raw: string): LinesUrlParts | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.has(url.hostname)) return null;

  const m = PATH.exec(url.pathname);
  if (!m) return null;

  const [, accountId, chatbotKey, bucketId, chatId] = m;
  if (!accountId || !chatbotKey || !bucketId || !chatId) return null;
  try {
    return { accountId, chatbotKey: decodeURIComponent(chatbotKey), bucketId, chatId };
  } catch {
    return null;
  }
}
