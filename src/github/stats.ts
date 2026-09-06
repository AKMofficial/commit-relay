/** Never throws: 401, 403, 404, rate limits, 5xx, timeout, oversized body and an
 *  unexpected shape all resolve to `stats: null` plus one `warn` (9.5, rows 15-21). */

import type { Deps } from '../runtime/deps.ts';
import { readCapped } from '../core/bytes.ts';
import { backoffMs, clampSleep, isTimeoutError, retryAfterMs } from '../core/backoff.ts';
import type { CommitStats } from '../core/types.ts';
import { commitUrl } from './url.ts';

export interface StatsRequest {
  owner: string;
  repo: string;
  sha: string;
  apiBase: string;
  token: string | null;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  deliveryId?: string;
  /** The job's own controller, aborted when ENRICH_DEADLINE_MS elapses. */
  signal?: AbortSignal;
}

/** `pauseMs` is set only when GitHub asked for a wait; the enricher pauses on it
 *  instead of retrying immediately (9.7). */
export interface StatsOutcome {
  stats: CommitStats | null;
  pauseMs?: number;
}

/** `now` is here only to turn the absolute `x-ratelimit-reset` epoch into a
 *  relative pause; injecting it keeps this module off every global. */
export type StatsDeps = Pick<Deps, 'fetchImpl' | 'sleep' | 'log' | 'now'>;

const RETRIES = 2;
const BACKOFF_BASE_MS = 250;
/** Nothing GitHub sends can stall the pipeline for longer than this. */
const MAX_PAUSE_MS = 60_000;
const TEXT_DECODER = new TextDecoder();

const RATELIMIT_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-used',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resetMs(header: string | null, nowSeconds: number): number | null {
  if (header === null) return null;
  const resetAt = Number(header.trim());
  if (!Number.isFinite(resetAt)) return null;
  const ms = Math.round((resetAt - nowSeconds) * 1000);
  if (ms <= 0) return null;
  return clampSleep(ms, MAX_PAUSE_MS);
}

function rateLimitFields(res: Response): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const name of RATELIMIT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) fields[name] = value;
  }
  return fields;
}

function parseStats(payload: unknown): CommitStats | null {
  if (!isRecord(payload)) return null;
  const stats = payload['stats'];
  if (!isRecord(stats)) return null;
  const additions = stats['additions'];
  const deletions = stats['deletions'];
  const total = stats['total'];
  if (!isFiniteNumber(additions) || !isFiniteNumber(deletions)) return null;
  const parents = payload['parents'];
  if (!Array.isArray(parents)) return null;
  return {
    additions,
    deletions,
    total: isFiniteNumber(total) ? total : additions + deletions,
    parentsCount: parents.length,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export async function fetchCommitStats(req: StatsRequest, deps: StatsDeps): Promise<StatsOutcome> {
  try {
    return await run(req, deps);
  } catch (error) {
    // The never-throws contract is the point of this module, so the last resort
    // is a catch that still emits its one warn.
    deps.log('warn', 'stats_fetch_failed', {
      ...correlation(req),
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { stats: null };
  }
}

function correlation(req: StatsRequest): { sha: string; deliveryId: string | undefined } {
  return { sha: req.sha, deliveryId: req.deliveryId };
}

async function run(req: StatsRequest, deps: StatsDeps): Promise<StatsOutcome> {
  const base = correlation(req);
  const url = commitUrl(req.apiBase, req.owner, req.repo, req.sha);
  if (url === null) {
    deps.log('warn', 'stats_fetch_failed', { ...base, repo: `${req.owner}/${req.repo}`, reason: 'invalid_target' });
    return { stats: null };
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': req.userAgent,
  };
  if (req.token) headers['Authorization'] = `Bearer ${req.token}`;

  for (let attempt = 0; ; attempt += 1) {
    if (isAborted(req.signal)) {
      deps.log('warn', 'stats_deadline', base);
      return { stats: null };
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(req.timeoutMs)];
    if (req.signal) signals.push(req.signal);

    let res: Response;
    try {
      res = await deps.fetchImpl(url, { headers, signal: AbortSignal.any(signals) });
    } catch (error) {
      if (isAborted(req.signal)) {
        deps.log('warn', 'stats_deadline', base);
        return { stats: null };
      }
      if (attempt < RETRIES) {
        await deps.sleep(backoffMs(attempt, Math.random, BACKOFF_BASE_MS));
        continue;
      }
      if (isTimeoutError(error)) {
        deps.log('warn', 'stats_timeout', { ...base, timeoutMs: req.timeoutMs });
      } else {
        deps.log('warn', 'stats_fetch_failed', {
          ...base,
          attempt,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
      return { stats: null };
    }

    deps.log('debug', 'github_ratelimit', { ...base, status: res.status, ...rateLimitFields(res) });

    if (res.status === 200) {
      const raw = await readCapped(res.body, req.maxBytes);
      if (raw === null) {
        deps.log('warn', 'stats_fetch_failed', { ...base, attempt, reason: 'oversize', maxBytes: req.maxBytes });
        return { stats: null };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(TEXT_DECODER.decode(raw)) as unknown;
      } catch {
        deps.log('warn', 'stats_fetch_failed', { ...base, attempt, reason: 'malformed_json' });
        return { stats: null };
      }
      const stats = parseStats(payload);
      if (stats === null) {
        deps.log('warn', 'stats_fetch_failed', { ...base, attempt, reason: 'unexpected_shape' });
        return { stats: null };
      }
      return { stats };
    }

    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel();
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = retryAfterMs(res.headers.get('retry-after'), MAX_PAUSE_MS);
      if (remaining !== null && remaining.trim() === '0') {
        const reset = res.headers.get('x-ratelimit-reset');
        const pauseMs = resetMs(reset, deps.now() / 1000) ?? retryAfter ?? MAX_PAUSE_MS;
        deps.log('warn', 'github_rate_limited', { ...base, status: res.status, resetAt: reset, pauseMs });
        return { stats: null, pauseMs: clampSleep(pauseMs, MAX_PAUSE_MS) };
      }
      if (retryAfter !== null) {
        deps.log('warn', 'github_secondary_limit', {
          ...base,
          status: res.status,
          retryAfter: res.headers.get('retry-after'),
        });
        return { stats: null, pauseMs: retryAfter };
      }
      if (res.status === 429) {
        deps.log('warn', 'github_secondary_limit', { ...base, status: 429, retryAfter: null });
        return { stats: null };
      }
      deps.log('warn', 'stats_forbidden', {
        ...base,
        accepted: res.headers.get('x-accepted-github-permissions'),
      });
      return { stats: null };
    }

    if (res.status === 404 || res.status === 401) {
      await res.body?.cancel();
      deps.log('warn', 'stats_unavailable', {
        ...base,
        status: res.status,
        hint:
          res.status === 404
            ? 'a private repository returns 404 without a token, so the Changes row stays "N/A"'
            : 'the token was rejected',
      });
      return { stats: null };
    }

    await res.body?.cancel();
    if (res.status >= 500 && attempt < RETRIES) {
      await deps.sleep(backoffMs(attempt, Math.random, BACKOFF_BASE_MS));
      continue;
    }
    deps.log('warn', 'stats_fetch_failed', { ...base, attempt, status: res.status });
    return { stats: null };
  }
}
