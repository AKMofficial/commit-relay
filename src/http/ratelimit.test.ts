import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './ratelimit.ts';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('createRateLimiter', () => {
  it('allows exactly perMinute requests from one key, then 429s the next', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ perMinute: 5, now });
    for (let i = 0; i < 5; i++) expect(limiter.check('1.2.3.4').allowed).toBe(true);
    const denied = limiter.check('1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe('ip');
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('keeps buckets separate per key', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ perMinute: 2, now });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('refills continuously on the injected clock', () => {
    const c = clock();
    const limiter = createRateLimiter({ perMinute: 60, now: c.now });
    for (let i = 0; i < 60; i++) limiter.check('ip');
    expect(limiter.check('ip').allowed).toBe(false);
    c.advance(1_000);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);
  });

  it('caps a flood spread across a thousand forged addresses at the global bucket', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ perMinute: 10, now, globalMultiplier: 10 });
    let allowed = 0;
    let globalDenials = 0;
    for (let i = 0; i < 1000; i++) {
      const decision = limiter.check(`10.0.${Math.floor(i / 256)}.${i % 256}`);
      if (decision.allowed) allowed++;
      else if (decision.scope === 'global') globalDenials++;
    }
    expect(allowed).toBe(100);
    expect(globalDenials).toBe(900);
  });

  it('defaults the global bucket to a hundred times per-IP capacity', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ perMinute: 5, now });
    for (let i = 0; i < 500; i++) {
      expect(limiter.check(`ip-${i}`).allowed).toBe(true);
    }
    const denied = limiter.check('ip-500');
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe('global');
  });

  it('does not let an unsigned flood exhaust the signed half of the global bucket', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ perMinute: 10, now, globalMultiplier: 10 });
    for (let i = 0; i < 1000; i++) limiter.check(`10.0.${Math.floor(i / 256)}.${i % 256}`);
    expect(limiter.check('unsigned-ip').scope).toBe('global');
    expect(limiter.check('140.82.115.1', true).allowed).toBe(true);
  });

  it('does not spend an IP token when the global bucket is the one refusing', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ perMinute: 4, now, globalMultiplier: 2 });
    for (let i = 0; i < 8; i++) limiter.check(`ip-${i}`);
    const fresh = limiter.check('fresh-ip');
    expect(fresh.allowed).toBe(false);
    expect(fresh.scope).toBe('global');
  });

  it('reports a Retry-After that is at least one second', () => {
    const { now } = clock();
    const limiter = createRateLimiter({ perMinute: 120, now });
    for (let i = 0; i < 120; i++) limiter.check('ip');
    expect(limiter.check('ip').retryAfterSeconds).toBe(1);
  });

  it('drops refilled buckets once the key count passes the cap', () => {
    const c = clock();
    const limiter = createRateLimiter({ perMinute: 2, now: c.now, maxKeys: 8, globalMultiplier: 10_000 });
    for (let i = 0; i < 8; i++) limiter.check(`k-${i}`);
    c.advance(60_000);
    for (let i = 8; i < 40; i++) limiter.check(`k-${i}`);
    expect(limiter.check('victim').allowed).toBe(true);
    expect(limiter.check('victim').allowed).toBe(true);
    expect(limiter.check('victim').allowed).toBe(false);
  });
});

describe('credit: the verified-delivery refund', () => {
  it('returns the global token but never the per-IP one', () => {
    // perMinute 2 -> per-IP capacity 2, global capacity 2 * multiplier.
    const limiter = createRateLimiter({ perMinute: 2, now: () => 0, globalMultiplier: 1 });

    expect(limiter.check('ip-a', true).allowed).toBe(true);
    limiter.credit(true);
    expect(limiter.check('ip-a', true).allowed).toBe(true);
    limiter.credit(true);

    // Per-IP allowance is gone after two requests, refunds notwithstanding.
    const third = limiter.check('ip-a', true);
    expect(third.allowed).toBe(false);
    expect(third.scope).toBe('ip');

    // Global capacity is 2 here, so a third IP passing proves the refund happened.
    expect(limiter.check('ip-b', true).allowed).toBe(true);
  });

  it('cannot mint allowance by crediting more than was spent', () => {
    const limiter = createRateLimiter({ perMinute: 1, now: () => 0, globalMultiplier: 1 });
    for (let i = 0; i < 10; i += 1) limiter.credit(true);
    expect(limiter.check('ip-a', true).allowed).toBe(true);
    expect(limiter.check('ip-a', true).allowed).toBe(false); // clamped at capacity
  });

  it('a forged but well-shaped signature drains the signed half, since shape is all gate 1 knows', () => {
    // Documents the ACTUAL reach of the signed/unsigned split: it separates
    // well-formed callers from malformed ones, not attackers from GitHub. Those
    // requests fail gate 4, so they are never refunded and do accumulate.
    const limiter = createRateLimiter({ perMinute: 1, now: () => 0, globalMultiplier: 2 });
    expect(limiter.check('attacker-1', true).allowed).toBe(true);
    expect(limiter.check('attacker-2', true).allowed).toBe(true);
    const victim = limiter.check('github-ip', true);
    expect(victim.allowed).toBe(false);
    expect(victim.scope).toBe('global');
  });
});
