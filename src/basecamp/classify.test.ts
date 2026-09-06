import { describe, expect, it } from 'vitest';
import {
  BUDGET_EXHAUSTED,
  NETWORK,
  STATUS_TABLE,
  TIMEOUT,
  UNEXPECTED,
  classify,
  isFatalStatus,
  isSuccess,
} from './classify.ts';
import { clampSleep } from '../core/backoff.ts';
import { linesUrl, postLine, sanitizeBasecampError } from './client.ts';
import { redactText } from '../security/redact.ts';
import type { PostDeps } from './client.ts';
import type { PosterConfig } from './types.ts';

const KEY = 'super-secret-chatbot-key';
const URL_WITH_KEY = linesUrl({
  apiBase: 'https://3.basecampapi.com',
  accountId: '1234567',
  chatbotKey: KEY,
  bucketId: '2345678',
  chatId: '7654321',
});

const MAX_SLEEP_MS = 30_000;
const MIN_INTERVAL_MS = 250;

const EXPECTED: Record<string, {
  retry: false | 'once' | true;
  delayMs: number | null;
  fatal: boolean;
  countsAgainstBudget: 'none' | 'error' | 'rate';
  level: string;
}> = {
  201: { retry: false, delayMs: null, fatal: false, countsAgainstBudget: 'none', level: 'info' },
  400: { retry: false, delayMs: null, fatal: true, countsAgainstBudget: 'none', level: 'error' },
  401: { retry: false, delayMs: null, fatal: true, countsAgainstBudget: 'none', level: 'error' },
  403: { retry: false, delayMs: null, fatal: true, countsAgainstBudget: 'none', level: 'error' },
  404: { retry: false, delayMs: null, fatal: true, countsAgainstBudget: 'none', level: 'error' },
  406: { retry: 'once', delayMs: 1000, fatal: true, countsAgainstBudget: 'none', level: 'warn' },
  408: { retry: 'once', delayMs: null, fatal: true, countsAgainstBudget: 'error', level: 'warn' },
  415: { retry: false, delayMs: null, fatal: true, countsAgainstBudget: 'none', level: 'error' },
  422: { retry: false, delayMs: null, fatal: true, countsAgainstBudget: 'none', level: 'error' },
  429: { retry: true, delayMs: null, fatal: false, countsAgainstBudget: 'rate', level: 'warn' },
  500: { retry: true, delayMs: null, fatal: false, countsAgainstBudget: 'error', level: 'warn' },
  502: { retry: true, delayMs: null, fatal: false, countsAgainstBudget: 'error', level: 'warn' },
  503: { retry: true, delayMs: null, fatal: false, countsAgainstBudget: 'error', level: 'warn' },
  504: { retry: true, delayMs: null, fatal: false, countsAgainstBudget: 'error', level: 'warn' },
};

describe('classify: one test per row of the 10.2 table', () => {
  it('the table has a test for every one of its own keys, and no more', () => {
    expect(Object.keys(STATUS_TABLE).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [status, want] of Object.entries(EXPECTED)) {
    it(`${status}`, () => {
      const row = classify(Number(status));
      expect(row.retry).toBe(want.retry);
      expect(row.delayMs).toBe(want.delayMs);
      expect(row.fatal).toBe(want.fatal);
      expect(row.countsAgainstBudget).toBe(want.countsAgainstBudget);
      expect(row.level).toBe(want.level);
      expect(row.evt).not.toBe('');
    });
  }

  it('400 names the missing User-Agent as the documented cause', () => {
    expect(classify(400).note).toMatch(/User-Agent/);
  });

  it('401 logs basecamp_unauthorized so a rotated key is visible', () => {
    expect(classify(401).evt).toBe('basecamp_unauthorized');
  });

  it('404 documents the Reason: Account Inactive discriminator', () => {
    expect(classify(404).note).toMatch(/Account Inactive/);
  });

  it('401, 403 and 404 are fatal with zero retries', () => {
    for (const s of [401, 403, 404]) {
      expect(classify(s).retry).toBe(false);
      expect(isFatalStatus(s)).toBe(true);
    }
  });

  it('429 is retryable and does not consume the 5xx retry budget', () => {
    const row = classify(429);
    expect(row.retry).toBe(true);
    expect(row.fatal).toBe(false);
    expect(row.countsAgainstBudget).toBe('rate');
    expect(row.countsAgainstBudget).not.toBe('error');
  });

  it('500, 502, 503, 504 are retryable and consume the error budget', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(classify(s).retry).toBe(true);
      expect(classify(s).countsAgainstBudget).toBe('error');
    }
  });

  it('other 5xx falls into the same retryable class', () => {
    const row = classify(599);
    expect(row.retry).toBe(true);
    expect(row.countsAgainstBudget).toBe('error');
  });

  it('406 is retryable exactly once at a fixed 1000 ms, then fatal', () => {
    const row = classify(406);
    expect(row.retry).toBe('once');
    expect(row.delayMs).toBe(1000);
    expect(row.fatal).toBe(true);
  });

  it('408 and the network timeout are retryable at most once, then fatal, duplicate risk noted', () => {
    expect(classify(408).retry).toBe('once');
    expect(classify(408).fatal).toBe(true);
    expect(classify(408).note).toMatch(/duplicate/i);
    expect(TIMEOUT.retry).toBe('once');
    expect(TIMEOUT.note).toMatch(/duplicate/i);
  });

  it('a network failure is retryable against the error budget', () => {
    expect(NETWORK.retry).toBe(true);
    expect(NETWORK.countsAgainstBudget).toBe('error');
  });

  it('budget exhausted is fatal and logs message_dropped', () => {
    expect(BUDGET_EXHAUSTED.fatal).toBe(true);
    expect(BUDGET_EXHAUSTED.retry).toBe(false);
    expect(BUDGET_EXHAUSTED.evt).toBe('message_dropped');
  });

  it('an unruled status is permanent rather than looped on', () => {
    expect(classify(302)).toEqual(UNEXPECTED);
    expect(classify(418)).toEqual(UNEXPECTED);
  });
});

describe('201 is the only success', () => {
  it('201 succeeds and is not retried', () => {
    expect(isSuccess(201)).toBe(true);
    expect(classify(201).retry).toBe(false);
    expect(classify(201).fatal).toBe(false);
  });

  it('200 and 204 are not success', () => {
    for (const s of [200, 204]) {
      expect(isSuccess(s)).toBe(false);
      expect(classify(s).fatal).toBe(true);
      expect(classify(s).evt).toBe('basecamp_post_fatal');
    }
  });
});

const CFG: PosterConfig = {
  userAgent: 'commit-relay/0.1.0 (+https://example.invalid/repo)',
  timeoutMs: 10_000,
  minIntervalMs: MIN_INTERVAL_MS,
  maxSleepMs: MAX_SLEEP_MS,
  contentMaxBytes: 16_384,
  postRetryBudgetMs: 20_000,
  rateLimitWaitBudgetMs: 60_000,
};

async function sleepsFor(headers: Record<string, string>): Promise<number[]> {
  const sleeps: number[] = [];
  let n = 0;
  const deps: PostDeps = {
    fetch: () => Promise.resolve(new Response('{}', { status: n++ === 0 ? 429 : 201, headers })),
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    log: () => {},
  };
  await postLine('<div>x</div>', {
    apiBase: 'https://3.basecampapi.com',
    accountId: '1234567',
    chatbotKey: KEY,
    bucketId: '2345678',
    chatId: '7654321',
  }, CFG, deps);
  return sleeps;
}

describe('sleeps', () => {
  it('a 429 with no Retry-After, or an unparseable one, is never NaN or 0', async () => {
    const cases: Record<string, string>[] = [{}, { 'retry-after': 'soon' }, { 'retry-after': '-1' }];
    for (const headers of cases) {
      const sleeps = await sleepsFor(headers);
      expect(sleeps).toEqual([1000]);
    }
  });

  it('an absurd Retry-After is clamped by the poster itself', async () => {
    expect(await sleepsFor({ 'retry-after': '86400' })).toEqual([MAX_SLEEP_MS]);
  });

  it('every sleep is clamped to BASECAMP_MAX_SLEEP_MS', () => {
    for (const seconds of [1, 30, 31, 3600, 86_400]) {
      expect(clampSleep(seconds * 1000, MAX_SLEEP_MS)).toBeLessThanOrEqual(MAX_SLEEP_MS);
    }
    expect(classify(406).delayMs).toBeLessThanOrEqual(MAX_SLEEP_MS);
  });
});

describe('no classification output leaks the key or the URL', () => {
  it('no row text, and no rebuilt error, contains the key or the unredacted URL', () => {
    const rows = [...Object.values(STATUS_TABLE), NETWORK, TIMEOUT, BUDGET_EXHAUSTED, UNEXPECTED];
    for (const row of rows) {
      const text = JSON.stringify(row);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(URL_WITH_KEY);
    }
    for (const status of [400, 401, 404, 406, 408, 429, 500, 503]) {
      const err = sanitizeBasecampError(status, `${status} for ${URL_WITH_KEY}`);
      expect(err.message).not.toContain(KEY);
      expect(err.message).not.toContain(URL_WITH_KEY);
      expect(err.message).toContain(String(status));
    }
  });

  it('redactText removes the key from the only loggable form of the URL', () => {
    expect(redactText(URL_WITH_KEY)).not.toContain(KEY);
    expect(redactText(URL_WITH_KEY)).toContain('/integrations/***');
  });
});
