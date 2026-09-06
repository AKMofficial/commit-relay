/** Every binding arrives as a string, so every numeric and boolean field is
 *  coerced explicitly here rather than by an implicit `Number()` downstream (7.1). */

import { parseLinesUrl } from './lines-url.ts';

export type EnvSource = Record<string, string | undefined>;

/** The 32-character floor on GITHUB_WEBHOOK_SECRET (11.2). A config-boot rule
 *  only: `src/security/hmac.ts` enforces no policy at all. */
export const SECRET_MIN_LENGTH = 32;

export const NUMERIC_MESSAGE =
  'must be a whole number written as digits (bindings are strings, so "15" is fine and "fifteen", "1e9" and an empty value are not).';

export const BOOLEAN_MESSAGE = 'must be one of true, false, 1, 0, yes, no, on, off.';

/** Empty check applied *after* the trim: a dashboard-pasted trailing newline is
 *  the real-world failure mode, so whitespace-only counts as missing. */
export function readValue(source: EnvSource, key: string): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Trimmed, but a present-and-blank value survives as `''` so the numeric and
 *  boolean coercers can reject it by name instead of silently defaulting. */
function readRaw(source: EnvSource, key: string): string | undefined {
  const raw = source[key];
  return raw === undefined ? undefined : raw.trim();
}

/** Unparseable input is handed back untouched so zod reports the field by name. */
export function coerceInt(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^-?\d{1,15}$/.test(value) ? Number(value) : value;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

export function coerceBool(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const v = value.toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  return value;
}

export function coerceList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Variables whose value is a number or a boolean. They keep a present-but-blank
 *  value so the schema can name it; everything else treats blank as missing.
 *  PR_ACTIONS is included because a blank value must mean no pull request action
 *  at all, not the default action list. */
const RAW_KEYS = new Set([
  'BASECAMP_TIMEOUT_MS',
  'BASECAMP_MIN_INTERVAL_MS',
  'BASECAMP_MAX_SLEEP_MS',
  'GITHUB_CONCURRENCY',
  'GITHUB_TIMEOUT_MS',
  'GITHUB_STATS_MAX_BYTES',
  'REQUIRE_LINE_STATS',
  'SKIP_FORCED_PUSHES',
  'SKIP_MERGE_COMMITS',
  'SKIP_NON_DISTINCT',
  'PR_ACTIONS',
  'PR_REVIEWS',
  'PR_SKIP_DRAFTS',
  'MAX_COMMITS_PER_PUSH',
  'SUBREQUEST_BUDGET',
  'COMMIT_BODY_MAX_CHARS',
  'CONTENT_MAX_BYTES',
  'ENRICH_DEADLINE_MS',
  'POST_RETRY_BUDGET_MS',
  'RATELIMIT_WAIT_BUDGET_MS',
  'MAX_QUEUE_DEPTH',
  'MAX_QUEUE_BYTES',
  'DEDUP_MAX_ENTRIES',
  'DEDUP_TTL_HOURS',
  'DROP_ALERT_WINDOW_MS',
  'MAX_BODY_BYTES',
  'RATE_LIMIT_PER_MINUTE',
  'TRUSTED_PROXY_HOPS',
  'PORT',
  'SHUTDOWN_DRAIN_MS',
  'LOG_PAYLOADS',
]);

/** Every variable the schema knows about, in the order of the 7.3 tables. The
 *  example files are asserted against exactly this list. */
export const CONFIG_KEYS = [
  'BASECAMP_LINES_URL',
  'BASECAMP_ACCOUNT_ID',
  'BASECAMP_CHATBOT_KEY',
  'BASECAMP_BUCKET_ID',
  'BASECAMP_CHAT_ID',
  'BASECAMP_API_BASE',
  'BASECAMP_TIMEOUT_MS',
  'BASECAMP_MIN_INTERVAL_MS',
  'BASECAMP_MAX_SLEEP_MS',
  'USER_AGENT',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_TOKEN',
  'GITHUB_API_BASE',
  'GITHUB_WEB_ORIGIN',
  'GITHUB_CONCURRENCY',
  'GITHUB_TIMEOUT_MS',
  'GITHUB_STATS_MAX_BYTES',
  'FETCH_LINE_STATS',
  'REQUIRE_LINE_STATS',
  'ROUTES',
  'CONFIG_FILE',
  'BRANCHES',
  'TAGS',
  'REPO_ALLOWLIST',
  'SKIP_FORCED_PUSHES',
  'SKIP_MERGE_COMMITS',
  'SKIP_NON_DISTINCT',
  'IGNORE_AUTHORS',
  'PR_ACTIONS',
  'PR_REVIEWS',
  'PR_SKIP_DRAFTS',
  'MAX_COMMITS_PER_PUSH',
  'SUBREQUEST_BUDGET',
  'COMMIT_BODY_MAX_CHARS',
  'CONTENT_MAX_BYTES',
  'ENRICH_DEADLINE_MS',
  'POST_RETRY_BUDGET_MS',
  'RATELIMIT_WAIT_BUDGET_MS',
  'MAX_QUEUE_DEPTH',
  'MAX_QUEUE_BYTES',
  'DEDUP_MAX_ENTRIES',
  'DEDUP_TTL_HOURS',
  'DROP_ALERT_WINDOW_MS',
  'MAX_BODY_BYTES',
  'RATE_LIMIT_PER_MINUTE',
  'TRUSTED_PROXY_HOPS',
  'WEBHOOK_PATH',
  'PORT',
  'SHUTDOWN_DRAIN_MS',
  'LOG_LEVEL',
  'LOG_PAYLOADS',
  'HEALTH_TOKEN',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

const SUFFIXED_PREFIXES = [
  'GITHUB_TOKEN_',
  'GITHUB_WEBHOOK_SECRET_',
  'BASECAMP_CHATBOT_KEY_',
] as const;

/** The `<SUFFIX>` families of 7.3, which a route target references by name. */
export function suffixedSecretNames(source: EnvSource): string[] {
  return Object.keys(source)
    .filter((key) => SUFFIXED_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .filter((key) => readValue(source, key) !== undefined)
    .sort();
}

export function isSet(source: EnvSource, name: string): boolean {
  return readValue(source, name) !== undefined;
}

export interface MappedEnv {
  values: Record<string, unknown>;
  /** Present but unparseable BASECAMP_LINES_URL; reported by the schema. */
  linesUrlInvalid: boolean;
}

/** `BASECAMP_LINES_URL` wins over the four discrete variables when both are set:
 *  it is one secret carrying all four, the form the README quickstart recommends. */
export function mapEnv(source: EnvSource): MappedEnv {
  const values: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = RAW_KEYS.has(key) ? readRaw(source, key) : readValue(source, key);
    if (value !== undefined) values[key] = value;
  }

  let linesUrlInvalid = false;
  const linesUrl = readValue(source, 'BASECAMP_LINES_URL');
  if (linesUrl !== undefined) {
    const parts = parseLinesUrl(linesUrl);
    if (parts === null) {
      linesUrlInvalid = true;
    } else {
      values['BASECAMP_ACCOUNT_ID'] = parts.accountId;
      values['BASECAMP_CHATBOT_KEY'] = parts.chatbotKey;
      values['BASECAMP_BUCKET_ID'] = parts.bucketId;
      values['BASECAMP_CHAT_ID'] = parts.chatId;
    }
  }

  return { values, linesUrlInvalid };
}
