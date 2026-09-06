/** The status classification table of 10.2, as data, so a test can enumerate its
 *  own keys and fail on any row that grew no test. */

import type { LogLevel } from '../obs/log.ts';

/** `false` never retries; `'once'` retries at most one time; `true` retries
 *  until the relevant budget is spent. */
export type RetryPolicy = false | 'once' | true;

/** Which wall-time budget the sleep before the retry is drawn from. `'rate'` is
 *  `RATELIMIT_WAIT_BUDGET_MS`; `'error'` is `POST_RETRY_BUDGET_MS`. */
export type BudgetKind = 'none' | 'error' | 'rate';

export interface Classification {
  retry: RetryPolicy;
  /** A fixed delay in milliseconds, or null when the delay is computed:
   *  `Retry-After` when the budget is `'rate'`, jittered backoff when `'error'`. */
  delayMs: number | null;
  /** True once the retry allowance in `retry` is spent: a `'once'` row is fatal
   *  on its second occurrence, not on its first. */
  fatal: boolean;
  countsAgainstBudget: BudgetKind;
  level: LogLevel;
  evt: string;
  /** The documented cause, carried so a log line or an operator message can name
   *  it; 400 is the missing-`User-Agent` response. */
  note: string;
}

export const CREATED = 201;

/** Every row of 10.2 that is keyed by a status code. */
export const STATUS_TABLE: Readonly<Record<number, Classification>> = {
  201: {
    retry: false,
    delayMs: null,
    fatal: false,
    countsAgainstBudget: 'none',
    level: 'info',
    evt: 'message_posted',
    note: 'The only success code. Drain the body, then apply the pacing interval.',
  },
  400: {
    retry: false,
    delayMs: null,
    fatal: true,
    countsAgainstBudget: 'none',
    level: 'error',
    evt: 'basecamp_post_fatal',
    note: 'Documented as the missing User-Agent response; also malformed JSON. A client bug.',
  },
  401: {
    retry: false,
    delayMs: null,
    fatal: true,
    countsAgainstBudget: 'none',
    level: 'error',
    evt: 'basecamp_unauthorized',
    note: 'Invalid, rotated, or revoked chatbot key. Flips the config-health flag.',
  },
  403: {
    retry: false,
    delayMs: null,
    fatal: true,
    countsAgainstBudget: 'none',
    level: 'error',
    evt: 'basecamp_post_fatal',
    note: 'Permanent config error.',
  },
  404: {
    retry: false,
    delayMs: null,
    fatal: true,
    countsAgainstBudget: 'none',
    level: 'error',
    evt: 'basecamp_post_fatal',
    note: 'Wrong bucket, wrong chat, deleted campfire or chatbot, or an inactive account; check the Reason: Account Inactive header. Do not automatically retry.',
  },
  406: {
    retry: 'once',
    delayMs: 1000,
    fatal: true,
    countsAgainstBudget: 'none',
    level: 'warn',
    evt: 'basecamp_post_retry',
    note: 'OBSERVED, not documented. Transient for exactly one attempt, then fatal.',
  },
  408: {
    retry: 'once',
    delayMs: null,
    fatal: true,
    countsAgainstBudget: 'error',
    level: 'warn',
    evt: 'basecamp_post_retry',
    note: 'Same class as a post-body timeout; with no idempotency key the retry can duplicate a line.',
  },
  415: {
    retry: false,
    delayMs: null,
    fatal: true,
    countsAgainstBudget: 'none',
    level: 'error',
    evt: 'basecamp_post_fatal',
    note: 'Missing or wrong Content-Type. Client bug.',
  },
  422: {
    retry: false,
    delayMs: null,
    fatal: true,
    countsAgainstBudget: 'none',
    level: 'error',
    evt: 'basecamp_post_fatal',
    note: 'Invalid content. Retrying resends the same bad body.',
  },
  429: {
    retry: true,
    delayMs: null,
    fatal: false,
    countsAgainstBudget: 'rate',
    level: 'warn',
    evt: 'basecamp_rate_limited',
    note: 'Sleep Retry-After seconds, clamped. Draws on the rate-limit wait budget, never the 5xx retry budget.',
  },
  500: serverRow('500 Internal Server Error'),
  502: serverRow('502 Bad Gateway'),
  503: serverRow('503 Service Unavailable'),
  504: serverRow('504 Gateway Timeout'),
};

function serverRow(note: string): Classification {
  return {
    retry: true,
    delayMs: null,
    fatal: false,
    countsAgainstBudget: 'error',
    level: 'warn',
    evt: 'basecamp_post_retry',
    note: `${note}: documented as retryable with exponential backoff.`,
  };
}

export const NETWORK: Classification = {
  retry: true,
  delayMs: null,
  fatal: false,
  countsAgainstBudget: 'error',
  level: 'warn',
  evt: 'basecamp_post_retry',
  note: 'No status was received, so nothing was necessarily delivered.',
};

/** A timeout after the request body was fully sent: at most one retry, because
 *  the endpoint has no idempotency key and the duplicate risk is real. */
export const TIMEOUT: Classification = {
  retry: 'once',
  delayMs: null,
  fatal: false,
  countsAgainstBudget: 'error',
  level: 'warn',
  evt: 'basecamp_timeout',
  note: 'The request may have landed; a rare duplicate beats a rare silent loss.',
};

export const BUDGET_EXHAUSTED: Classification = {
  retry: false,
  delayMs: null,
  fatal: true,
  countsAgainstBudget: 'none',
  level: 'error',
  evt: 'message_dropped',
  note: 'Cumulative retry wall time spent; dropped loudly on Node, re-queued on Workers up to MAX_DEFERRALS then dropped.',
};

export const UNEXPECTED: Classification = {
  retry: false,
  delayMs: null,
  fatal: true,
  countsAgainstBudget: 'none',
  level: 'error',
  evt: 'basecamp_post_fatal',
  note: 'No rule for this status; treated as permanent rather than retried.',
};

export function classify(status: number): Classification {
  const row = STATUS_TABLE[status];
  if (row) return row;
  if (status >= 500) return serverRow(`${status} server error`);
  return UNEXPECTED;
}

/** A terminal 401, 403 or 404 means the chatbot key was rotated, the bot was removed
 *  from the Campfire, or the ids are wrong. All three are otherwise invisible: the
 *  room simply goes quiet. They flip the config-health flag (rows 24-25, 14.4). */
const CONFIG_HEALTH_FLIPPING: ReadonlySet<number> = new Set([401, 403, 404]);

export function flipsConfigHealth(status: number): boolean {
  return CONFIG_HEALTH_FLIPPING.has(status);
}

export function isFatalStatus(status: number): boolean {
  const row = STATUS_TABLE[status];
  return row !== undefined && row.retry === false && row.fatal;
}

export function isSuccess(status: number): boolean {
  return status === CREATED;
}
