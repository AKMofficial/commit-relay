const BASE_MS = 1000;
const CAP_MS = 8000;

export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs: number = BASE_MS,
): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // stats.ts shares this 0.5-1.0× jitter via baseMs=250.
  return Math.min(baseMs * 2 ** n, CAP_MS) * (0.5 + random() / 2);
}

export function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err
    && (err as { name?: unknown }).name === 'TimeoutError';
}

/** `retry-after` is documented as seconds; an unparseable value must not become NaN. */
export function retryAfterMs(header: string | null, maxMs: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return clampSleep(Math.round(seconds * 1000), maxMs);
}

/** Every sleep, from any source, is clamped: an unclamped remote value stalls
 *  every repository and every room on a single-consumer queue (10.2). */
export function clampSleep(ms: number, maxMs: number): number {
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0;
  if (Number.isNaN(ms) || ms <= 0) return 0;
  return Math.min(ms, cap);
}

/** Beyond this, a remote `until` is treated as clock skew, not as pacing. */
export const MAX_UNTIL_SKEW_MS = 60_000;

/** `until` is a remote clock; anything unparseable, past, or >60s ahead is
 *  rejected. Not on the v1 path: pacer.ts never reads `until` (10.3). */
export function rejectSkewedUntil(untilIso: string, nowMs: number): number | null {
  const at = Date.parse(untilIso);
  if (!Number.isFinite(at)) return null;
  const delta = at - nowMs;
  if (delta <= 0) return null;
  if (delta > MAX_UNTIL_SKEW_MS) return null;
  return delta;
}

/** Wall time, not attempt counts, so the budget means what the config table says. */
export class WallTimeBudget {
  readonly totalMs: number;
  private spentMs = 0;

  constructor(totalMs: number) {
    this.totalMs = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  }

  get remainingMs(): number {
    return this.totalMs - this.spentMs;
  }

  canAfford(ms: number): boolean {
    return ms <= this.remainingMs;
  }

  /** A refused spend costs nothing. */
  spend(ms: number): boolean {
    if (!this.canAfford(ms)) return false;
    this.spentMs += ms;
    return true;
  }

}
