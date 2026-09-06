/** The exact shapes `postLine()` consumes (10.8). */

/** Everything needed to build one chatbot lines URL. The key is a bearer
 *  credential sitting in a URL path, so this object never reaches a log line
 *  unredacted. */
export interface BasecampTarget {
  apiBase: string;
  accountId: string;
  chatbotKey: string;
  bucketId: string;
  chatId: string;
}

export interface PosterConfig {
  userAgent: string;
  timeoutMs: number;
  minIntervalMs: number;
  maxSleepMs: number;
  contentMaxBytes: number;
  /** Wall time the poster may spend asleep on 5xx, network and timeout. */
  postRetryBudgetMs: number;
  /** The separate wall-time budget that 429 and x-ratelimit sleeps draw on. */
  rateLimitWaitBudgetMs: number;
}

export type PostReason =
  | 'created'
  | 'content_too_large'
  | 'rate_limited'
  | 'account_inactive'
  | 'config_error'
  | 'unexpected_status'
  | 'network'
  | 'budget_exhausted'
  /** Per-invocation subrequest ceiling reached; deferrable. */
  | 'subrequest_budget';

export interface PostResult {
  ok: boolean;
  fatal: boolean;
  status: number;
  reason: PostReason;
  /** Seconds the caller should ask the queue to wait; only on `rate_limited`. */
  retryAfterS?: number;
  pacingMs: number;
}
