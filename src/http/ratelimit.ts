/** Gate #1 of 9.3: a per-IP bucket plus a global bucket at a hundred times its size,
 *  so spoofing a fresh key per request cannot escape a ceiling.
 *
 *  The global bucket is split by signature SHAPE, which only separates well-formed
 *  callers from malformed ones; a forged 64-hex header draws on the signed half too.
 *  The guarantee that holds is the refund: a delivery that passes HMAC gets its global
 *  token back, while its per-IP allowance (RATE_LIMIT_PER_MINUTE) stays spent. */

export interface RateLimitDecision {
  allowed: boolean;
  scope: 'ip' | 'global' | null;
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  perMinute: number;
  now: () => number;
  globalMultiplier?: number;
  /** Above this many tracked keys, refilled-to-full buckets are dropped. */
  maxKeys?: number;
}

export interface RateLimiter {
  /** `signed` selects the global half: true only for a well-shaped signature header. */
  check(key: string, signed?: boolean): RateLimitDecision;
  /** Refund the global token after HMAC verification. The per-IP token stays spent. */
  credit(signed?: boolean): void;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const perIpCapacity = options.perMinute;
  const globalCapacity = options.perMinute * (options.globalMultiplier ?? 100);
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, Bucket>();
  const globalBuckets: Record<'signed' | 'unsigned', Bucket> = {
    signed: { tokens: globalCapacity, updatedAt: options.now() },
    unsigned: { tokens: globalCapacity, updatedAt: options.now() },
  };

  function refill(bucket: Bucket, capacity: number, at: number): void {
    const elapsed = Math.max(0, at - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * capacity) / 60_000);
    bucket.updatedAt = at;
  }

  function retryAfter(bucket: Bucket, capacity: number): number {
    const perMs = capacity / 60_000;
    return Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
  }

  /** A bucket that has refilled to capacity is indistinguishable from one that
   *  never existed, so dropping it bounds memory without weakening the limit. */
  function prune(at: number): void {
    if (buckets.size <= maxKeys) return;
    for (const [key, bucket] of buckets) {
      refill(bucket, perIpCapacity, at);
      if (bucket.tokens >= perIpCapacity) buckets.delete(key);
    }
  }

  return {
    check(key, signed = false) {
      const at = options.now();
      const globalBucket = globalBuckets[signed ? 'signed' : 'unsigned'];

      let bucket = buckets.get(key);
      if (bucket === undefined) {
        // Prune before inserting, so the bucket being created now - which is
        // full, and therefore prunable - is never the one dropped.
        prune(at);
        bucket = { tokens: perIpCapacity, updatedAt: at };
        buckets.set(key, bucket);
      }
      refill(bucket, perIpCapacity, at);
      refill(globalBucket, globalCapacity, at);

      // Both buckets are checked before either is spent, so a global refusal
      // does not also burn the caller's own allowance.
      if (bucket.tokens < 1) {
        return { allowed: false, scope: 'ip', retryAfterSeconds: retryAfter(bucket, perIpCapacity) };
      }
      if (globalBucket.tokens < 1) {
        return {
          allowed: false,
          scope: 'global',
          retryAfterSeconds: retryAfter(globalBucket, globalCapacity),
        };
      }

      bucket.tokens -= 1;
      globalBucket.tokens -= 1;
      return { allowed: true, scope: null, retryAfterSeconds: 0 };
    },

    credit(signed = false) {
      const at = options.now();
      const globalBucket = globalBuckets[signed ? 'signed' : 'unsigned'];
      refill(globalBucket, globalCapacity, at);
      // Clamped, so a duplicate credit cannot mint allowance.
      globalBucket.tokens = Math.min(globalCapacity, globalBucket.tokens + 1);
    },
  };
}
