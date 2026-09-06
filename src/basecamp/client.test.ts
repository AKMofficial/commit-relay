import { beforeEach, describe, expect, it } from 'vitest';
import { linesUrl, postLine, sanitizeBasecampError } from './client.ts';
import { contentBytes } from '../core/bytes.ts';
import { buildCommitTable, type CommitView } from '../render/message.ts';
import { type RenderLimits } from '../render/table.ts';
import { redactText } from '../security/redact.ts';
import type { PostDeps } from './client.ts';
import type { BasecampTarget, PosterConfig } from './types.ts';

const KEY = 'super-secret-chatbot-key';

const TARGET: BasecampTarget = {
  apiBase: 'https://3.basecampapi.com',
  accountId: '1234567',
  chatbotKey: KEY,
  bucketId: '2345678',
  chatId: '7654321',
};

const FULL_URL = linesUrl(TARGET);

const CFG: PosterConfig = {
  userAgent: 'commit-relay/0.1.0 (+https://example.invalid/repo)',
  timeoutMs: 10_000,
  minIntervalMs: 250,
  maxSleepMs: 30_000,
  contentMaxBytes: 16_384,
  postRetryBudgetMs: 20_000,
  rateLimitWaitBudgetMs: 60_000,
};

const RATE_HEADER =
  '{"name":"API","period":10,"limit":50,"remaining":49,"until":"2026-08-31T11:15:20Z"}, '
  + '{"name":"API_PATH","period":10,"limit":20,"remaining":49,"until":"2026-08-31T11:15:20Z"}';

interface Harness {
  deps: PostDeps;
  urls: string[];
  inits: RequestInit[];
  sleeps: number[];
  logs: { level: string; evt: string; fields: Record<string, unknown> }[];
  responses: Response[];
}

type Step = () => Response | never;

function harness(steps: Step[]): Harness {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const sleeps: number[] = [];
  const logs: Harness['logs'] = [];
  const responses: Response[] = [];
  let i = 0;

  const deps: PostDeps = {
    fetch: (input, init) => {
      urls.push(String(input));
      inits.push(init ?? {});
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      if (!step) throw new Error('no step');
      const res = step();
      responses.push(res);
      return Promise.resolve(res);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    log: (level, evt, fields) => {
      logs.push({ level, evt, fields });
    },
  };

  return { deps, urls, inits, sleeps, logs, responses };
}

function res(status: number, headers: Record<string, string> = {}): Response {
  const body = status === 204 || status === 304 ? null : '{"id":1}';
  return new Response(body, { status, headers });
}

let html: string;
beforeEach(() => {
  html = '<div dir="ltr"><table dir="ltr" cellpadding="4"></table></div>';
});

describe('the request', () => {
  it('posts the documented URL, headers and body, and 201 is success', async () => {
    const h = harness([() => res(201)]);
    const out = await postLine(html, TARGET, CFG, h.deps);

    expect(out).toMatchObject({ ok: true, fatal: false, status: 201, reason: 'created' });
    expect(h.urls).toEqual([
      'https://3.basecampapi.com/1234567/integrations/super-secret-chatbot-key'
      + '/buckets/2345678/chats/7654321/lines.json',
    ]);
    const init = h.inits[0];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': CFG.userAgent,
      Accept: 'application/json',
    });
    expect(init?.body).toBe(JSON.stringify({ content: html }));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('parses the x-ratelimit header and returns the pacing interval', async () => {
    const h = harness([() => res(201, { 'x-ratelimit': RATE_HEADER })]);
    const out = await postLine(html, TARGET, CFG, h.deps);
    expect(out.pacingMs).toBe(625);
  });

  it('falls back to the minimum interval when the header is absent or malformed', async () => {
    const cases: Record<string, string>[] = [{}, { 'x-ratelimit': 'not json' }];
    for (const headers of cases) {
      const h = harness([() => res(201, headers)]);
      const out = await postLine(html, TARGET, CFG, h.deps);
      expect(out.pacingMs).toBe(CFG.minIntervalMs);
    }
  });

  it('drains the body on 201 and on an error status', async () => {
    for (const status of [201, 422, 500]) {
      const h = harness([() => res(status)]);
      await postLine(html, TARGET, { ...CFG, postRetryBudgetMs: 0 }, h.deps);
      expect(h.responses.every((r) => r.bodyUsed)).toBe(true);
    }
  });

  it('rejects content over the byte cap without making a request', async () => {
    const h = harness([() => res(201)]);
    const out = await postLine('x'.repeat(200), TARGET, { ...CFG, contentMaxBytes: 32 }, h.deps);
    expect(out).toEqual({
      ok: false,
      fatal: true,
      status: 0,
      reason: 'content_too_large',
      pacingMs: CFG.minIntervalMs,
    });
    expect(h.urls).toEqual([]);
  });

  it('posts when buildCommitTable sits exactly at the envelope cap', async () => {
    const lim: RenderLimits = { bodyMaxCodePoints: 2000, contentMaxBytes: 1200, webOrigin: 'https://github.com' };
    const view: CommitView = {
      repoFullName: 'your-org/your-repo',
      refKind: 'branch',
      refName: 'main',
      author: 'Ada',
      fileCount: 1,
      additions: 1,
      deletions: 0,
      message: '"'.repeat(120),
      commitUrl: 'https://github.com/your-org/your-repo/commit/abc',
    };
    const html = buildCommitTable(view, lim);
    expect(contentBytes(html)).toBeLessThanOrEqual(lim.contentMaxBytes);
    const h = harness([() => res(201)]);
    const out = await postLine(html, TARGET, { ...CFG, contentMaxBytes: lim.contentMaxBytes }, h.deps);
    expect(out.ok).toBe(true);
    expect(out.reason).not.toBe('content_too_large');
  });

  it('never returns content_too_large for renderer output across a spread of caps', async () => {
    const view: CommitView = {
      repoFullName: 'your-org/your-repo',
      refKind: 'branch',
      refName: 'main',
      author: 'Ada',
      fileCount: 1,
      additions: 1,
      deletions: 0,
      message: 'subject\n' + 'body '.repeat(400) + '"'.repeat(100),
      commitUrl: 'https://github.com/your-org/your-repo/commit/abc',
    };
    const h = harness([() => res(201)]);
    for (const cap of [1024, 4096, 8192, 16384]) {
      const html = buildCommitTable(view, { bodyMaxCodePoints: 2000, contentMaxBytes: cap, webOrigin: 'https://github.com' });
      expect(contentBytes(html)).toBeLessThanOrEqual(cap);
      const out = await postLine(html, TARGET, { ...CFG, contentMaxBytes: cap }, h.deps);
      expect(out.reason).not.toBe('content_too_large');
    }
  });
});

describe('429', () => {
  it('sleeps Retry-After and draws on rateWaitLeft, never on errorWaitLeft', async () => {
    const h = harness([
      () => res(429, { 'retry-after': '2' }),
      () => res(201),
    ]);
    const out = await postLine(html, TARGET, { ...CFG, postRetryBudgetMs: 0 }, h.deps);

    expect(out.ok).toBe(true);
    expect(h.sleeps).toEqual([2000]);
    expect(h.logs[0]).toMatchObject({ level: 'warn', evt: 'basecamp_rate_limited' });
  });

  it('clamps Retry-After to the maximum sleep', async () => {
    const h = harness([() => res(429, { 'retry-after': '86400' }), () => res(201)]);
    await postLine(html, TARGET, CFG, h.deps);
    expect(h.sleeps).toEqual([CFG.maxSleepMs]);
  });

  it('never sleeps NaN or 0 when Retry-After is missing or unparseable', async () => {
    const cases: Record<string, string>[] = [{}, { 'retry-after': 'soon' }, { 'retry-after': '-1' }];
    for (const headers of cases) {
      const h = harness([() => res(429, headers), () => res(201)]);
      await postLine(html, TARGET, CFG, h.deps);
      expect(h.sleeps).toEqual([1000]);
    }
  });

  it('defers to the queue, non-fatally, once the rate budget cannot cover the wait', async () => {
    const h = harness([() => res(429, { 'retry-after': '10' })]);
    const out = await postLine(html, TARGET, { ...CFG, rateLimitWaitBudgetMs: 5_000 }, h.deps);
    expect(out).toMatchObject({ ok: false, fatal: false, status: 429, reason: 'rate_limited', retryAfterS: 10 });
    expect(h.sleeps).toEqual([]);
    expect(h.logs[0]?.evt).toBe('basecamp_rate_limited_deferred');
  });

  it('floors Retry-After 0 at 1000 ms and defers once the rate budget is exhausted', async () => {
    const always429 = (): Response => res(429, { 'retry-after': '0' });
    const h = harness(Array.from({ length: 10 }, () => always429));
    const out = await postLine(html, TARGET, { ...CFG, rateLimitWaitBudgetMs: 5_000 }, h.deps);
    expect(out).toMatchObject({ ok: false, fatal: false, status: 429, reason: 'rate_limited' });
    expect(h.sleeps.every((ms) => ms >= 1000)).toBe(true);
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(5_000);
  });
});

describe('5xx, network and timeouts', () => {
  it('backs off on 5xx against errorWaitLeft, not the rate budget', async () => {
    const h = harness([() => res(503), () => res(201)]);
    const out = await postLine(html, TARGET, { ...CFG, rateLimitWaitBudgetMs: 0 }, h.deps);

    expect(out.ok).toBe(true);
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(h.sleeps[0]).toBeLessThanOrEqual(1000);
    expect(h.logs[0]).toMatchObject({ level: 'warn', evt: 'basecamp_post_retry' });
    expect(h.logs[0]?.fields).toMatchObject({ status: 503, attempt: 0 });
  });

  it('retries every documented 5xx and the undocumented rest of the class', async () => {
    for (const status of [500, 502, 503, 504, 599]) {
      const h = harness([() => res(status), () => res(201)]);
      const out = await postLine(html, TARGET, CFG, h.deps);
      expect(out.ok).toBe(true);
      expect(h.urls).toHaveLength(2);
    }
  });

  it('retries a network error, then DEFERS when the error budget cannot cover the backoff', async () => {
    // A connect error never reached Basecamp, so exhaustion defers like 5xx (row 23).
    const boom = (): never => {
      throw new TypeError(`fetch failed for ${FULL_URL}`);
    };
    const h = harness([boom]);
    const out = await postLine(html, TARGET, { ...CFG, postRetryBudgetMs: 3_000 }, h.deps);

    expect(out).toMatchObject({ ok: false, fatal: false, status: 0, reason: 'budget_exhausted' });
    expect(out.retryAfterS).toBeGreaterThan(0);
    expect(h.sleeps.length).toBeGreaterThanOrEqual(1);
    const failed = h.logs.at(-1);
    expect(failed).toMatchObject({ level: 'warn', evt: 'basecamp_post_failed' });
    expect(failed?.fields.reason).toBe('budget_exhausted');
    expect(failed?.fields.cause).toBe('network');
  });

  it('logs basecamp_timeout for our own AbortSignal.timeout and retries it at most once', async () => {
    const timeout = (): never => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const h = harness([timeout]);
    const out = await postLine(html, TARGET, CFG, h.deps);

    expect(out).toMatchObject({ ok: false, fatal: true, status: 0, reason: 'network' });
    const retry = h.logs.find((l) => l.evt === 'basecamp_timeout');
    expect(retry).toMatchObject({ level: 'warn', fields: { reason: 'timeout' } });
    expect(h.logs.filter((l) => l.evt === 'basecamp_timeout')).toHaveLength(1);
    expect(h.urls).toHaveLength(2);
    expect(h.logs.at(-1)).toMatchObject({ level: 'error', evt: 'basecamp_post_failed', fields: { reason: 'timeout' } });
  });

  it('reports budget_exhausted when 5xx outlasts the retry budget', async () => {
    const h = harness([() => res(500)]);
    const out = await postLine(html, TARGET, { ...CFG, postRetryBudgetMs: 400 }, h.deps);
    expect(out).toMatchObject({
      ok: false,
      fatal: false,
      status: 500,
      reason: 'budget_exhausted',
      retryAfterS: 60,
    });
    expect(h.logs.at(-1)).toMatchObject({ level: 'warn', evt: 'basecamp_post_failed' });
  });

  it('retries 408 exactly once, then treats it as fatal', async () => {
    const h = harness([() => res(408)]);
    const out = await postLine(html, TARGET, CFG, h.deps);
    expect(h.urls).toHaveLength(2);
    expect(out).toMatchObject({ ok: false, fatal: true, status: 408, reason: 'config_error' });
  });
});

describe('406', () => {
  it('retries exactly once at a fixed 1000 ms', async () => {
    const h = harness([() => res(406), () => res(201)]);
    const out = await postLine(html, TARGET, CFG, h.deps);
    expect(h.sleeps).toEqual([1000]);
    expect(out.ok).toBe(true);
  });

  it('is fatal on the second occurrence', async () => {
    const h = harness([() => res(406)]);
    const out = await postLine(html, TARGET, CFG, h.deps);
    expect(h.urls).toHaveLength(2);
    expect(out).toMatchObject({ ok: false, fatal: true, status: 406 });
  });
});

describe('fatal statuses', () => {
  it('never retries 400, 401, 403, 404, 415 or 422', async () => {
    for (const status of [400, 401, 403, 404, 415, 422]) {
      const h = harness([() => res(status)]);
      const out = await postLine(html, TARGET, CFG, h.deps);
      expect(h.urls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
      expect(out).toMatchObject({ ok: false, fatal: true, status, reason: 'config_error' });
      const evt = status === 401 ? 'basecamp_unauthorized' : 'basecamp_post_fatal';
      expect(h.logs[0]).toMatchObject({ level: 'error', evt });
    }
  });

  it('separates a lapsed account from a wrong id via the Reason header', async () => {
    const h = harness([() => res(404, { reason: 'Account Inactive' })]);
    const out = await postLine(html, TARGET, CFG, h.deps);
    expect(out.reason).toBe('account_inactive');
    expect(h.logs[0]?.fields.accountInactive).toBe(true);
  });

  it('treats 200, 204 and any other unruled status as permanent, not as success', async () => {
    for (const status of [200, 204, 302, 418]) {
      const h = harness([() => res(status)]);
      const out = await postLine(html, TARGET, CFG, h.deps);
      expect(out.ok).toBe(false);
      expect(out.fatal).toBe(true);
      expect(out.reason).toBe('unexpected_status');
      expect(h.urls).toHaveLength(1);
    }
  });
});

describe('no key and no URL ever escape this file', () => {
  it('holds for every status, every log field, and the rebuilt error', async () => {
    const statuses = [201, 200, 400, 401, 403, 404, 406, 408, 415, 422, 429, 500, 503];
    for (const status of statuses) {
      const h = harness([() => res(status, { 'retry-after': '1' })]);
      const out = await postLine(html, TARGET, { ...CFG, postRetryBudgetMs: 500 }, h.deps);

      const seen = JSON.stringify({ logs: h.logs, out });
      expect(seen).not.toContain(KEY);
      expect(seen).not.toContain(FULL_URL);
      for (const entry of h.logs) {
        expect(entry.fields.url).toBe(redactText(FULL_URL));
      }
    }
  });

  it('sanitizeBasecampError rebuilds the message from status and statusText only', async () => {
    expect(sanitizeBasecampError(404, 'Not Found').message).toBe('Basecamp responded 404 Not Found');
    expect(sanitizeBasecampError(500).message).toBe('Basecamp responded 500');

    const err = sanitizeBasecampError(404, `<html>${FULL_URL}</html>`);
    expect(err.message).not.toContain(FULL_URL);
    expect(err.message).not.toContain(KEY);
    expect(err.code).toBe('basecamp_http');

    const h = harness([() => res(404)]);
    await expect(postLine(html, TARGET, CFG, h.deps)).resolves.toBeDefined();
  });
});

describe('config health and the documented cause', () => {
  it('a terminal 401 logs the event 10.2 names for that row', async () => {
    const h = harness([() => res(401)]);
    const out = await postLine(html, TARGET, CFG, h.deps);

    expect(out.fatal).toBe(true);
    expect(h.logs.at(-1)).toMatchObject({ level: 'error', evt: 'basecamp_unauthorized', fields: { status: 401 } });
  });

  it('other terminal statuses keep basecamp_post_fatal', async () => {
    for (const status of [400, 403, 404, 415, 422]) {
      const h = harness([() => res(status)]);
      await postLine(html, TARGET, CFG, h.deps);
      expect(h.logs.at(-1)).toMatchObject({ level: 'error', evt: 'basecamp_post_fatal', fields: { status } });
    }
  });

  it('config_unhealthy is left to the queue poster, which owns the metric', async () => {
    for (const status of [401, 404]) {
      const h = harness([() => res(status)]);
      await postLine(html, TARGET, CFG, h.deps);
      expect(h.logs.some((l) => l.evt === 'config_unhealthy')).toBe(false);
    }
  });

  it('the 400 log line names the missing User-Agent as the documented cause', async () => {
    const h = harness([() => res(400)]);
    await postLine(html, TARGET, CFG, h.deps);
    expect(String(h.logs[0]?.fields.cause)).toMatch(/User-Agent/);
  });

  it('the 404 log line names the Account Inactive discriminator', async () => {
    const h = harness([() => res(404)]);
    await postLine(html, TARGET, CFG, h.deps);
    expect(String(h.logs[0]?.fields.cause)).toMatch(/Account Inactive/);
  });

  it('the 408 retry log line documents the duplicate risk', async () => {
    const h = harness([() => res(408), () => res(201)]);
    await postLine(html, TARGET, CFG, h.deps);
    expect(h.logs[0]).toMatchObject({ evt: 'basecamp_post_retry', fields: { status: 408 } });
    expect(String(h.logs[0]?.fields.cause)).toMatch(/duplicate/i);
  });
});
