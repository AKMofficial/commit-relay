import { describe, expect, it } from 'vitest';
import type { LogFn, LogLevel } from '../obs/log.ts';
import { fetchCommitStats, type StatsDeps, type StatsRequest } from './stats.ts';
import { resolveStatsMode, requireLineStatsViolated } from './token.ts';
import { commitUrl, isValidSegment, isValidSha, splitFullName } from './url.ts';
import single from '../../tests/fixtures/commit.stats.json' with { type: 'json' };
import merge from '../../tests/fixtures/commit.stats.merge.json' with { type: 'json' };

const SHA = '0123456789abcdef0123456789abcdef01234567';
const API_BASE = 'https://api.github.com';

interface LogLine {
  level: LogLevel;
  evt: string;
  fields: Record<string, unknown>;
}

interface Harness {
  deps: StatsDeps;
  logs: LogLine[];
  calls: Array<{ url: string; headers: Headers }>;
  slept: number[];
}

function harness(impl: (call: number) => Response | Promise<Response>): Harness {
  const logs: LogLine[] = [];
  const calls: Array<{ url: string; headers: Headers }> = [];
  const slept: number[] = [];
  const log: LogFn = (level, evt, fields) => {
    logs.push({ level, evt, fields: fields ?? {} });
  };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const n = calls.length;
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return await impl(n);
  }) as typeof fetch;
  return {
    logs,
    calls,
    slept,
    deps: {
      fetchImpl,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      log,
      now: () => 1_700_000_000_000,
    },
  };
}

function request(overrides: Partial<StatsRequest> = {}): StatsRequest {
  return {
    owner: 'your-org',
    repo: 'your-repo',
    sha: SHA,
    apiBase: API_BASE,
    token: null,
    userAgent: 'commit-relay/0.1.0',
    timeoutMs: 8_000,
    maxBytes: 1_048_576,
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function warns(logs: LogLine[]): LogLine[] {
  return logs.filter((line) => line.level === 'warn');
}

describe('commitUrl', () => {
  it('builds the documented request with per_page=1', () => {
    expect(commitUrl(API_BASE, 'your-org', 'your-repo', SHA)).toBe(
      `https://api.github.com/repos/your-org/your-repo/commits/${SHA}?per_page=1`,
    );
  });

  it('keeps the GHES path prefix after new URL() normalization', () => {
    const url = commitUrl('https://ghe.example.com/api/v3', 'your-org', 'your-repo', SHA);
    expect(url).toBe(
      `https://ghe.example.com/api/v3/repos/your-org/your-repo/commits/${SHA}?per_page=1`,
    );
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe('https://ghe.example.com');
    expect(parsed.pathname.startsWith('/api/v3/')).toBe(true);
  });

  it('rejects segments that could climb out of the base path', () => {
    for (const bad of ['.', '..', '../..', './..', 'a/b', 'a%2f..', '', 'x'.repeat(101)]) {
      expect(isValidSegment(bad)).toBe(false);
      expect(commitUrl('https://ghe.example.com/api/v3', bad, 'your-repo', SHA)).toBeNull();
      expect(commitUrl('https://ghe.example.com/api/v3', 'your-org', bad, SHA)).toBeNull();
    }
    expect(splitFullName('./..')).toBeNull();
    expect(splitFullName('your-org/your-repo')).toEqual({ owner: 'your-org', repo: 'your-repo' });
  });

  it('rejects anything that is not a 40-hex commit id', () => {
    for (const bad of ['', 'HEAD', SHA.toUpperCase(), SHA.slice(0, 39), `${SHA}0`, `${SHA}/../..`, '../../etc']) {
      expect(isValidSha(bad)).toBe(false);
      expect(commitUrl(API_BASE, 'your-org', 'your-repo', bad)).toBeNull();
    }
    expect(isValidSha(SHA)).toBe(true);
  });

  it('rejects a base that is not an absolute http(s) URL', () => {
    for (const bad of ['', 'api.github.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(commitUrl(bad, 'your-org', 'your-repo', SHA)).toBeNull();
    }
  });
});

describe('resolveStatsMode', () => {
  it('resolves the stats mode and the REQUIRE_LINE_STATS boot check', () => {
    expect(resolveStatsMode('auto', true)).toBe('on');
    expect(resolveStatsMode('auto', false)).toBe('off');
    expect(resolveStatsMode('on', false)).toBe('on');
    expect(resolveStatsMode('off', true)).toBe('off');
    expect(requireLineStatsViolated(true, 'auto', false)).toBe(true);
    expect(requireLineStatsViolated(true, 'off', true)).toBe(true);
    expect(requireLineStatsViolated(true, 'on', false)).toBe(false);
    expect(requireLineStatsViolated(false, 'off', false)).toBe(false);
  });
});

describe('fetchCommitStats', () => {
  it('reads additions, deletions, total and the parent count', async () => {
    const h = harness(() => json(single));
    await expect(fetchCommitStats(request(), h.deps)).resolves.toEqual({
      stats: { additions: 42, deletions: 7, total: 49, parentsCount: 1 },
    });
    expect(warns(h.logs)).toHaveLength(0);
  });

  it('reports a merge commit through parents.length', async () => {
    const h = harness(() => json(merge));
    const out = await fetchCommitStats(request(), h.deps);
    expect(out.stats?.parentsCount).toBe(2);
  });

  it('sends the documented headers and per_page=1, with no Authorization when no token resolves', async () => {
    const h = harness(() => json(single));
    await fetchCommitStats(request(), h.deps);
    const call = h.calls[0];
    expect(call?.url).toContain('per_page=1');
    expect(call?.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call?.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(call?.headers.get('user-agent')).toBe('commit-relay/0.1.0');
    expect(call?.headers.has('authorization')).toBe(false);
  });

  it('sends Bearer only when a token resolves', async () => {
    const h = harness(() => json(single));
    await fetchCommitStats(request({ token: 'route-token' }), h.deps);
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer route-token');
  });

  it('never sends a route token to a different base than the route named', async () => {
    const h = harness(() => json(single));
    await fetchCommitStats(
      request({ token: 'ghes-token', apiBase: 'https://ghe.example.com/api/v3' }),
      h.deps,
    );
    expect(h.calls[0]?.url.startsWith('https://ghe.example.com/api/v3/repos/')).toBe(true);
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer ghes-token');
  });

  it('abandons the call with one warn when the target cannot be validated', async () => {
    const h = harness(() => json(single));
    await expect(fetchCommitStats(request({ owner: '..' }), h.deps)).resolves.toEqual({ stats: null });
    expect(h.calls).toHaveLength(0);
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['stats_fetch_failed']);
  });

  it('logs the documented rate-limit headers at debug', async () => {
    const h = harness(() =>
      json(single, 200, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4998',
        'x-ratelimit-used': '2',
        'x-ratelimit-reset': '1700000600',
        'x-ratelimit-resource': 'core',
      }),
    );
    await fetchCommitStats(request(), h.deps);
    const debug = h.logs.find((line) => line.level === 'debug');
    expect(debug?.evt).toBe('github_ratelimit');
    expect(debug?.fields['x-ratelimit-remaining']).toBe('4998');
    expect(debug?.fields['x-ratelimit-reset']).toBe('1700000600');
  });

  it('carries the private-repo hint on 404', async () => {
    const h = harness(() => json({ message: 'Not Found' }, 404));
    await expect(fetchCommitStats(request(), h.deps)).resolves.toEqual({ stats: null });
    const warn = warns(h.logs);
    expect(warn).toHaveLength(1);
    expect(warn[0]?.evt).toBe('stats_unavailable');
    expect(warn[0]?.fields['status']).toBe(404);
    expect(String(warn[0]?.fields['hint'])).toContain('private repository');
  });

  it('reports 401 as stats_unavailable', async () => {
    const h = harness(() => json({ message: 'Bad credentials' }, 401));
    await expect(fetchCommitStats(request({ token: 'bad' }), h.deps)).resolves.toEqual({ stats: null });
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['stats_unavailable']);
  });

  it('reports a permission 403 with X-Accepted-GitHub-Permissions', async () => {
    const h = harness(() => json({ message: 'Resource not accessible' }, 403, {
      'x-accepted-github-permissions': 'contents=read',
    }));
    await expect(fetchCommitStats(request({ token: 'weak' }), h.deps)).resolves.toEqual({ stats: null });
    const warn = warns(h.logs);
    expect(warn).toHaveLength(1);
    expect(warn[0]?.evt).toBe('stats_forbidden');
    expect(warn[0]?.fields['accepted']).toBe('contents=read');
  });

  it('returns a clamped pause on a primary rate limit', async () => {
    const h = harness(() =>
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(1_700_000_000 + 20),
      }),
    );
    const out = await fetchCommitStats(request(), h.deps);
    expect(out.stats).toBeNull();
    expect(out.pauseMs).toBe(20_000);
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['github_rate_limited']);
  });

  it('falls through to Retry-After when x-ratelimit-reset is already past', async () => {
    const h = harness(() =>
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(1_699_999_000),
        'retry-after': '60',
      }),
    );
    const out = await fetchCommitStats(request(), h.deps);
    expect(out.pauseMs).toBe(60_000);
  });

  it('clamps a hostile x-ratelimit-reset', async () => {
    const h = harness(() =>
      json('', 429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '99999999999' }),
    );
    const out = await fetchCommitStats(request(), h.deps);
    expect(out.pauseMs).toBe(60_000);
  });

  it('returns a clamped pause on a secondary limit carrying retry-after', async () => {
    const h = harness(() => json('', 403, { 'retry-after': '5' }));
    const out = await fetchCommitStats(request(), h.deps);
    expect(out).toEqual({ stats: null, pauseMs: 5_000 });
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['github_secondary_limit']);
  });

  it('clamps a hostile retry-after and survives a junk one', async () => {
    const big = harness(() => json('', 429, { 'retry-after': '86400' }));
    expect((await fetchCommitStats(request(), big.deps)).pauseMs).toBe(60_000);
    const junk = harness(() => json('', 429, { 'retry-after': 'soon' }));
    const out = await fetchCommitStats(request(), junk.deps);
    expect(out.stats).toBeNull();
    expect(warns(junk.logs).map((l) => l.evt)).toEqual(['github_secondary_limit']);
  });

  it('retries a 5xx twice and then gives up with one warn', async () => {
    const h = harness(() => json({ message: 'server error' }, 500));
    await expect(fetchCommitStats(request(), h.deps)).resolves.toEqual({ stats: null });
    expect(h.calls).toHaveLength(3);
    expect(h.slept).toHaveLength(2);
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['stats_fetch_failed']);
  });

  it('recovers when a retry succeeds', async () => {
    const h = harness((n) => (n === 0 ? json('', 503) : json(single)));
    const out = await fetchCommitStats(request(), h.deps);
    expect(out.stats?.additions).toBe(42);
    expect(warns(h.logs)).toHaveLength(0);
  });

  it('retries a network error and reports stats_fetch_failed', async () => {
    const h = harness(() => Promise.reject(new TypeError('network failure')));
    await expect(fetchCommitStats(request(), h.deps)).resolves.toEqual({ stats: null });
    expect(h.calls).toHaveLength(3);
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['stats_fetch_failed']);
  });

  it('reports a timeout as stats_timeout', async () => {
    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    const h = harness(() => Promise.reject(timeout));
    await expect(fetchCommitStats(request(), h.deps)).resolves.toEqual({ stats: null });
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['stats_timeout']);
  });

  it('reports an enrichment deadline abort as stats_deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness(() => json(single));
    await expect(fetchCommitStats(request({ signal: controller.signal }), h.deps)).resolves.toEqual({
      stats: null,
    });
    expect(h.calls).toHaveLength(0);
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['stats_deadline']);
  });

  it('reports an abort that lands mid-flight as stats_deadline, not a retry', async () => {
    const controller = new AbortController();
    const h = harness(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    await expect(fetchCommitStats(request({ signal: controller.signal }), h.deps)).resolves.toEqual({
      stats: null,
    });
    expect(h.calls).toHaveLength(1);
    expect(warns(h.logs).map((l) => l.evt)).toEqual(['stats_deadline']);
  });

  it('resolves to null for malformed JSON, an empty body and an unexpected shape', async () => {
    for (const body of ['{"stats":', '', 'null', '[]', '{"stats":{}}', '{"stats":{"additions":"42","deletions":7},"parents":[]}', '{"stats":{"additions":1,"deletions":2,"total":3}}']) {
      const h = harness(() => json(body));
      await expect(fetchCommitStats(request(), h.deps)).resolves.toEqual({ stats: null });
      expect(warns(h.logs)).toHaveLength(1);
      expect(warns(h.logs)[0]?.evt).toBe('stats_fetch_failed');
    }
  });

  it('survives a truncated stream', async () => {
    const h = harness(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"stats":{"additions":1,'));
              controller.error(new Error('connection reset'));
            },
          }),
          { status: 200 },
        ),
    );
    await expect(fetchCommitStats(request(), h.deps)).resolves.toEqual({ stats: null });
    expect(warns(h.logs)).toHaveLength(1);
  });

  it('aborts a 20 MB response against the byte budget instead of parsing it', async () => {
    const CHUNK = 64 * 1024;
    const TOTAL = 20 * 1024 * 1024;
    let pulled = 0;
    const h = harness(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= TOTAL) {
                controller.close();
                return;
              }
              pulled += CHUNK;
              controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
            },
          }),
          { status: 200 },
        ),
    );

    const out = await fetchCommitStats(request({ maxBytes: 1_048_576 }), h.deps);
    expect(out).toEqual({ stats: null });
    expect(pulled).toBeLessThan(TOTAL);
    expect(pulled).toBeLessThanOrEqual(1_048_576 + CHUNK * 2);
    const warn = warns(h.logs);
    expect(warn).toHaveLength(1);
    expect(warn[0]?.fields['reason']).toBe('oversize');
  });

  it('never throws for any status and body combination', async () => {
    const statuses = [200, 201, 204, 301, 304, 400, 401, 403, 404, 409, 422, 429, 451, 500, 502, 503, 504];
    const bodies = ['', '{}', 'null', '[]', 'not json', '{"stats":{"additions":1,"deletions":2,"total":3},"parents":[{}]}'];
    const headerSets: Array<Record<string, string>> = [
      {},
      { 'retry-after': '1' },
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000010' },
      { 'retry-after': '-9' },
      { 'x-ratelimit-remaining': 'nonsense' },
    ];

    let seed = 1;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let i = 0; i < 200; i += 1) {
      const status = statuses[next(statuses.length)] as number;
      const body = bodies[next(bodies.length)] as string;
      const headers = headerSets[next(headerSets.length)] as Record<string, string>;
      const h = harness(() => new Response(status === 204 || status === 304 ? null : body, { status, headers }));
      const out = await fetchCommitStats(request({ maxBytes: 1_048_576 }), h.deps);
      expect(out).toHaveProperty('stats');
      if (out.stats !== null) {
        expect(typeof out.stats.additions).toBe('number');
      } else {
        expect(warns(h.logs).length).toBe(1);
      }
      if (out.pauseMs !== undefined) {
        expect(out.pauseMs).toBeGreaterThanOrEqual(0);
        expect(out.pauseMs).toBeLessThanOrEqual(60_000);
      }
    }
  });
});
