// src/basecamp/client.ts
// Platform-pure: fetch, TextEncoder, AbortSignal, setTimeout. No node:*, no cloudflare:*.

import { CREATED, NETWORK, TIMEOUT, classify, isFatalStatus } from './classify.ts';
import { parseRateBuckets, pacingMs } from './pacer.ts';
import type { BasecampTarget, PosterConfig, PostResult } from './types.ts';
import { WallTimeBudget, backoffMs, isTimeoutError, retryAfterMs } from '../core/backoff.ts';
import { RelayError } from '../security/errors.ts';
import { contentBytes } from '../core/bytes.ts';
import { SubrequestBudgetExceeded } from '../core/subrequests.ts';
import { redactText } from '../security/redact.ts';

/** Handed back to the queue when the 5xx retry budget is spent; the poster defers instead of dropping. */
const BUDGET_EXHAUSTED_RETRY_S = 60;

export interface PostDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', evt: string, fields: Record<string, unknown>) => void;
}

export function linesUrl(t: BasecampTarget): string {
  return `${t.apiBase}/${t.accountId}/integrations/${t.chatbotKey}`
    + `/buckets/${t.bucketId}/chats/${t.chatId}/lines.json`;
}

/**
 * Rebuilt from `{status, statusText}`, never wrapped around the original: `fetch`
 * failures carry the request URL in their `cause` chain and the app host answers
 * with a whole HTML error page (11.1). `RelayError` redacts at construction.
 */
export function sanitizeBasecampError(status: number, statusText?: string): RelayError {
  const suffix = statusText === undefined || statusText === '' ? '' : ` ${statusText}`;
  return new RelayError('basecamp_http', `Basecamp responded ${status}${suffix}`);
}

/**
 * Post one chat line. Never throws. Returns the outcome plus the pacing interval the
 * caller must sleep before its next post.
 *
 * Budgets are separate on purpose: a rate-limited room must not burn the error allowance.
 * Both are wall-time, not attempt counts, so they mean the same thing the config table says.
 *   postRetryBudgetMs    - total wall time spent asleep on 5xx, network, timeout
 *   rateLimitWaitBudgetMs - total wall time spent asleep on 429
 */
export async function postLine(
  html: string,
  target: BasecampTarget,
  cfg: PosterConfig,
  deps: PostDeps,
): Promise<PostResult> {
  const url = linesUrl(target);
  const redactedUrl = redactText(url);
  const body = JSON.stringify({ content: html });

  const bytes = contentBytes(html);
  if (bytes > cfg.contentMaxBytes) {
    // The renderer is responsible for staying under the cap; reaching here is a bug.
    return { ok: false, fatal: true, status: 0, reason: 'content_too_large', pacingMs: cfg.minIntervalMs };
  }

  const errorBudget = new WallTimeBudget(cfg.postRetryBudgetMs);
  const rateBudget = new WallTimeBudget(cfg.rateLimitWaitBudgetMs);
  let fourOhSixUsed = false;
  let timeoutUsed = false;
  let fourOhEightUsed = false;
  let lastStatus = 0;
  let lastReason: 'network' | 'timeout' | 'server_error' = 'server_error';

  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await deps.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': cfg.userAgent,
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      // The ceiling is per invocation, so retrying here is pointless: defer, and the
      // queue resumes at resumeAtSeq with a fresh budget.
      if (err instanceof SubrequestBudgetExceeded) {
        deps.log('warn', 'basecamp_post_deferred', {
          url: redactedUrl,
          reason: 'subrequest_budget',
          attempts: attempt + 1,
        });
        return {
          ok: false,
          fatal: false,
          status: 0,
          reason: 'subrequest_budget',
          retryAfterS: BUDGET_EXHAUSTED_RETRY_S,
          pacingMs: cfg.minIntervalMs,
        };
      }
      // No status: connect error, DNS, TLS, reset, or our own timeout.
      const timedOut = isTimeoutError(err);
      const row = timedOut ? TIMEOUT : NETWORK;
      const reason = timedOut ? 'timeout' : 'network';
      const d = backoffMs(attempt);
      // A timeout may have landed, so row 26 allows exactly one retry, then stops.
      if (timedOut && timeoutUsed) {
        deps.log('error', 'basecamp_post_failed', { url: redactedUrl, reason, attempts: attempt + 1 });
        return { ok: false, fatal: true, status: 0, reason: 'network', pacingMs: cfg.minIntervalMs };
      }
      // A connect error never reached Basecamp, so exhaustion defers like 5xx (row 23).
      if (!errorBudget.spend(d)) {
        lastReason = reason;
        break;
      }
      if (timedOut) timeoutUsed = true;
      deps.log('warn', row.evt, { url: redactedUrl, reason, attempt });
      await deps.sleep(d);
      continue;
    }

    lastStatus = res.status;
    const row = classify(res.status);
    const fatal = isFatalStatus(res.status);
    // Read the undocumented pacing header BEFORE draining, then always drain the socket.
    const buckets = parseRateBuckets(res.headers.get('x-ratelimit'));
    await res.text();
    const pacing = pacingMs(buckets, cfg.minIntervalMs, cfg.maxSleepMs);

    if (res.status === CREATED) {
      return { ok: true, fatal: false, status: CREATED, reason: 'created', pacingMs: pacing };
    }

    if (res.status === 429) {
      const waitMs = Math.max(1000, retryAfterMs(res.headers.get('retry-after'), cfg.maxSleepMs) ?? 1000);
      if (!rateBudget.canAfford(waitMs)) {
        // Hand the wait back to the queue instead of holding an invocation open.
        deps.log('warn', 'basecamp_rate_limited_deferred', { url: redactedUrl, waitMs });
        return { ok: false, fatal: false, status: 429, reason: 'rate_limited',
                 retryAfterS: Math.ceil(waitMs / 1000), pacingMs: pacing };
      }
      rateBudget.spend(waitMs);               // does NOT touch the error budget
      deps.log('warn', 'basecamp_rate_limited', { url: redactedUrl, waitMs });
      await deps.sleep(waitMs);
      continue;
    }

    // OBSERVED once, never reproduced, undocumented. Transient for exactly one attempt.
    if (res.status === 406 && !fourOhSixUsed) {
      fourOhSixUsed = true;
      deps.log('warn', 'basecamp_post_retry', { url: redactedUrl, reason: '406_observed', attempt });
      await deps.sleep(1000);
      continue;
    }

    // Same class as a post-body timeout: retried at most once, and it can duplicate a line.
    if (res.status === 408 && !fourOhEightUsed) {
      fourOhEightUsed = true;
      deps.log('warn', 'basecamp_post_retry',
        { url: redactedUrl, status: 408, attempt, cause: row.note });
      await deps.sleep(backoffMs(attempt));
      continue;
    }

    if (fatal || res.status === 406 || res.status === 408) {
      const inactive = res.headers.get('reason') === 'Account Inactive';
      // 401 is the one row of 10.2 that names its own event; 406/408 land here only
      // once their single retry is spent, where the classified row still says retry.
      const evt = fatal ? row.evt : 'basecamp_post_fatal';
      deps.log('error', evt, {
        url: redactedUrl,
        status: res.status,
        accountInactive: inactive,
        cause: row.note,
        error: sanitizeBasecampError(res.status, res.statusText).message,
      });
      return { ok: false, fatal: true, status: res.status,
               reason: inactive ? 'account_inactive' : 'config_error', pacingMs: pacing };
    }

    if (res.status >= 500) {
      const d = backoffMs(attempt);
      if (!errorBudget.spend(d)) {
        lastReason = 'server_error';
        break;
      }
      deps.log('warn', 'basecamp_post_retry', { url: redactedUrl, status: res.status, attempt });
      await deps.sleep(d);
      continue;
    }

    // Any other 4xx/3xx we have no rule for: treat as permanent rather than loop on it.
    deps.log('error', 'basecamp_post_fatal', {
      url: redactedUrl,
      status: res.status,
      cause: row.note,
      error: sanitizeBasecampError(res.status, res.statusText).message,
    });
    return { ok: false, fatal: true, status: res.status, reason: 'unexpected_status', pacingMs: pacing };
  }

  deps.log('warn', 'basecamp_post_failed', {
    url: redactedUrl,
    status: lastStatus,
    reason: 'budget_exhausted',
    cause: lastReason,
  });
  return {
    ok: false,
    fatal: false,
    status: lastStatus,
    reason: 'budget_exhausted',
    retryAfterS: BUDGET_EXHAUSTED_RETRY_S,
    pacingMs: cfg.minIntervalMs,
  };
}
