import { describe, expect, it } from 'vitest';
import {
  MAX_UNTIL_SKEW_MS,
  WallTimeBudget,
  backoffMs,
  clampSleep,
  rejectSkewedUntil,
} from './backoff.ts';

describe('backoffMs', () => {
  it('is min(1000 * 2^attempt, 8000) scaled by the injected jitter', () => {
    for (const [attempt, base] of [[0, 1000], [1, 2000], [2, 4000], [3, 8000], [9, 8000]] as const) {
      expect(backoffMs(attempt, () => 0)).toBe(base * 0.5);
      expect(backoffMs(attempt, () => 1)).toBe(base);
    }
  });

  it('always lands between half the base and the base', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const base = Math.min(1000 * 2 ** attempt, 8000);
      const d = backoffMs(attempt);
      expect(d).toBeGreaterThanOrEqual(base / 2);
      expect(d).toBeLessThanOrEqual(base);
    }
  });

  it('caps at 8000 ms however large the attempt is', () => {
    expect(backoffMs(40, () => 1)).toBe(8000);
  });
});

describe('clampSleep', () => {
  it('clamps to the maximum', () => {
    expect(clampSleep(90_000, 30_000)).toBe(30_000);
    expect(clampSleep(1_000, 30_000)).toBe(1_000);
  });

  it('never returns NaN or a negative duration', () => {
    for (const bad of [Number.NaN, -1, -0, Number.POSITIVE_INFINITY]) {
      const ms = clampSleep(bad, 30_000);
      expect(Number.isNaN(ms)).toBe(false);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(clampSleep(Number.POSITIVE_INFINITY, 30_000)).toBe(30_000);
    expect(clampSleep(1000, Number.NaN)).toBe(0);
  });
});

describe('rejectSkewedUntil', () => {
  const now = Date.parse('2026-08-31T11:15:00Z');

  it('returns the remaining duration for a plausible until', () => {
    expect(rejectSkewedUntil('2026-08-31T11:15:20Z', now)).toBe(20_000);
  });

  it('rejects an until more than 60 s in the future as clock skew', () => {
    expect(rejectSkewedUntil('2026-08-31T11:16:01Z', now)).toBeNull();
    expect(rejectSkewedUntil('2099-01-01T00:00:00Z', now)).toBeNull();
  });

  it('accepts exactly the skew boundary', () => {
    expect(rejectSkewedUntil('2026-08-31T11:16:00Z', now)).toBe(MAX_UNTIL_SKEW_MS);
  });

  it('rejects a past or unparseable until', () => {
    expect(rejectSkewedUntil('2026-08-31T11:14:59Z', now)).toBeNull();
    expect(rejectSkewedUntil('2026-08-31T11:15:00Z', now)).toBeNull();
    expect(rejectSkewedUntil('not a date', now)).toBeNull();
    expect(rejectSkewedUntil('', now)).toBeNull();
  });
});

describe('WallTimeBudget', () => {
  it('spends wall time until the allowance is gone', () => {
    const b = new WallTimeBudget(20_000);
    expect(b.remainingMs).toBe(20_000);
    expect(b.spend(8_000)).toBe(true);
    expect(b.spend(8_000)).toBe(true);
    expect(b.remainingMs).toBe(4_000);
    expect(b.canAfford(4_001)).toBe(false);
    expect(b.spend(4_001)).toBe(false);
    expect(b.remainingMs).toBe(4_000);
    expect(b.spend(4_000)).toBe(true);
    expect(b.remainingMs).toBe(0);
  });

  it('keeps two budgets independent, so a rate limit cannot burn the error allowance', () => {
    const error = new WallTimeBudget(20_000);
    const rate = new WallTimeBudget(60_000);
    rate.spend(30_000);
    expect(error.remainingMs).toBe(20_000);
    expect(rate.remainingMs).toBe(30_000);
  });

  it('a zero or invalid allowance affords nothing', () => {
    expect(new WallTimeBudget(0).spend(1)).toBe(false);
    expect(new WallTimeBudget(Number.NaN).remainingMs).toBe(0);
    expect(new WallTimeBudget(-5).remainingMs).toBe(0);
  });
});
