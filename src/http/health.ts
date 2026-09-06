import { tryGetConfig } from '../config/load.ts';
import { readValue } from '../config/env.ts';
import type { EnvSource } from '../config/env.ts';
import type { LoadOptions } from '../config/load.ts';
import type { MetricName } from '../obs/metrics.ts';
import type { MetricsStore } from '../obs/metrics.ts';
import type { Target } from '../obs/log.ts';
import { UTF8_ENCODER } from '../core/bytes.ts';
import pkg from '../../package.json' with { type: 'json' };

export type HealthBody =
  | { status: 'ok' }
  | { status: 'config_invalid'; missing: string[] }
  | { status: 'unhealthy'; reason?: string };

export interface HealthResponse {
  code: 200 | 500 | 503;
  body: HealthBody;
}

export interface HealthDeps {
  metrics?: MetricsStore;
  target?: Target;
  /** Node lifecycle: false before boot completes and from SIGTERM on, so a
   *  draining instance never tells a green lie (14.4). Workers leaves it unset. */
  isServing?: () => boolean;
  /** Node only; Workers has no resident process to measure (14.5). */
  rss?: () => number | null;
  now?: () => number;
  startedAt?: number;
}

let registered: HealthDeps = {};

export function setHealthDeps(deps: HealthDeps): void {
  registered = deps;
}

export function healthDeps(): HealthDeps {
  return registered;
}

const OK: HealthResponse = { code: 200, body: { status: 'ok' } };

function unhealthy(reason?: string): HealthResponse {
  return { code: 503, body: reason === undefined ? { status: 'unhealthy' } : { status: 'unhealthy', reason } };
}

/**
 * GET /healthz (14.4). `missing` names every invalid key at once, never values,
 * because validation cannot run at module load on Workers; `tryGetConfig` is
 * memoized on the source so Node reuses boot's result and its CONFIG_FILE reader.
 */
export function healthz(
  source: EnvSource = {},
  options: LoadOptions = {},
  deps: HealthDeps = registered,
): HealthResponse {
  const result = tryGetConfig(source, options);
  if (!result.ok) return { code: 500, body: { status: 'config_invalid', missing: result.missing } };

  const metrics = deps.metrics;
  if (metrics) {
    const now = (deps.now ?? Date.now)();
    // A rotated chatbot key is otherwise completely invisible.
    if (metrics.snapshot().configHealthy === 0) return unhealthy('basecamp_terminal');
    if (metrics.recentDrops(result.config.DROP_ALERT_WINDOW_MS, now)) return unhealthy('recent_drops');
  }

  // The pre-boot and SIGTERM rows of the 14.4 table are a bare 503: `reason` has
  // exactly two defined values and neither of them describes this window.
  if (deps.isServing !== undefined && !deps.isServing()) return unhealthy();

  return OK;
}

export type DetailBody = { status: 'not_found' } | { status: 'unauthorized' } | Record<string, unknown>;

export interface DetailResponse {
  code: 200 | 401 | 404;
  body: DetailBody;
}

const NOT_FOUND: DetailResponse = { code: 404, body: { status: 'not_found' } };
/** One generic word: a 401 never says why (11.4). */
const UNAUTHORIZED: DetailResponse = { code: 401, body: { status: 'unauthorized' } };

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', UTF8_ENCODER.encode(value)));
}

/** Both arguments are SHA-256 digests, so the lengths are equal by construction
 *  and no input can make this throw or leak a length (11.1 "500 oracle"). */
function equalDigests(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

function nullable(value: number): number | null {
  return value === 0 ? null : value;
}

function isoOrNull(value: number): string | null {
  return value === 0 ? null : new Date(value).toISOString();
}

function gauges(snapshot: Record<MetricName, number>): Record<string, unknown> {
  return {
    queueDepth: snapshot.queueDepth,
    queueBytes: snapshot.queueBytes,
    dedupeDeliveries: snapshot.dedupeDeliveries,
    dedupeCommits: snapshot.dedupeCommits,
    postedTotal: snapshot.postedTotal,
    retriedTotal: snapshot.retriedTotal,
    failedTotal: snapshot.failedTotal,
    droppedTotal: snapshot.droppedTotal,
    lastDropAt: isoOrNull(snapshot.lastDropAt),
    skippedTotal: snapshot.skippedTotal,
    statsUnavailableTotal: snapshot.statsUnavailableTotal,
    lastPostAt: isoOrNull(snapshot.lastPostAt),
    lastBasecampStatus: nullable(snapshot.lastBasecampStatus),
    configHealthy: snapshot.configHealthy === 1,
  };
}

/**
 * GET /health/detail (14.5). 404 unless HEALTH_TOKEN is set, so an unconfigured
 * deploy does not advertise the route; shape checks and the fixed-length digest
 * compare all return the same 401, so this is never a 401-versus-500 oracle (11.1).
 */
export async function healthDetail(
  request: Request,
  source: EnvSource = {},
  options: LoadOptions = {},
  deps: HealthDeps = registered,
): Promise<DetailResponse> {
  const result = tryGetConfig(source, options);
  // 14.5 conditions the 404 solely on HEALTH_TOKEN being unset: an operator needs
  // the gauges most when an unrelated key fails, so read the token from source.
  const expected = result.ok ? result.config.HEALTH_TOKEN : readValue(source, 'HEALTH_TOKEN');
  if (expected === undefined) return NOT_FOUND;

  const supplied = request.headers.get('x-health-token');
  if (supplied === null || supplied.length > 256 || !PRINTABLE_ASCII.test(supplied)) {
    return UNAUTHORIZED;
  }
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  if (!equalDigests(a, b)) return UNAUTHORIZED;

  const now = (deps.now ?? Date.now)();
  const startedAt = deps.startedAt ?? now;
  const rssMb = deps.rss ? deps.rss() : null;
  const snapshot = deps.metrics ? deps.metrics.snapshot() : null;

  return {
    code: 200,
    body: {
      uptimeS: Math.max(0, Math.floor((now - startedAt) / 1000)),
      target: deps.target ?? 'workers',
      version: pkg.version,
      ...(rssMb === null ? {} : { rssMb }),
      ...(snapshot === null ? {} : gauges(snapshot)),
    },
  };
}
