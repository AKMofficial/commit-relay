// src/basecamp/pacer.ts
export interface RateBucket {
  name: string;
  period: number;    // seconds
  limit: number;
  remaining: number;
  until: string;     // ISO-8601, wall clock, NOT used for arithmetic (see below)
}

/**
 * Parse the multi-valued, UNDOCUMENTED x-ratelimit header.
 * fetch() joins repeated headers with ", ", and each value is JSON containing commas,
 * so a naive split() destroys them. Brace-depth scan, then parse each candidate.
 * The scan is string-naive: a "{" inside a quoted value would confuse it, which is why
 * every candidate slice is JSON.parse'd defensively and silently dropped on failure.
 */
export function parseRateBuckets(headerValue: string | null): RateBucket[] {
  if (!headerValue) return [];
  const out: RateBucket[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const o: unknown = JSON.parse(headerValue.slice(start, i + 1));
          if (isRateBucket(o)) out.push(o);
        } catch {
          /* undocumented header, malformed value: ignore and fall back to the static pace */
        }
        start = -1;
      }
    }
  }
  return out;
}

function isRateBucket(o: unknown): o is RateBucket {
  if (typeof o !== 'object' || o === null) return false;
  const b = o as Record<string, unknown>;
  return typeof b.name === 'string'
    && typeof b.period === 'number' && b.period > 0
    && typeof b.limit === 'number' && b.limit > 0
    && typeof b.remaining === 'number';
}

/** Threshold at which we stop trickling and wait out the whole window. */
const LOW_WATER = 5;

/**
 * How long to sleep AFTER this response, before the next post.
 * Returns a duration, never an absolute deadline: the Workers runtime freezes the
 * observable clock outside I/O as a Spectre mitigation, so Date.now() deltas are not a
 * usable pacing source, and `until` is a remote wall clock we would have to trust.
 * Sleeping `period` seconds instead is both skew-proof and never longer than one window.
 */
export function pacingMs(buckets: RateBucket[], fallbackMs: number, maxSleepMs: number): number {
  if (buckets.length === 0) return fallbackMs;      // header absent -> static pace
  let ms = fallbackMs;
  for (const b of buckets) {
    // Self-pace to 80% of each bucket's own sustainable rate.
    const perRequest = Math.ceil((b.period * 1000) / b.limit / 0.8);
    if (perRequest > ms) ms = perRequest;
    // Nearly exhausted: sit out the rest of the window rather than earn a 429.
    if (b.remaining <= LOW_WATER) ms = Math.max(ms, b.period * 1000);
  }
  return Math.min(ms, maxSleepMs);
}
