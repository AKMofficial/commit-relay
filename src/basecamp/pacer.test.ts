import { describe, expect, it } from 'vitest';
import { parseRateBuckets, pacingMs } from './pacer.ts';

const API = '{"name":"API","period":10,"limit":50,"remaining":49,"until":"2026-08-31T11:15:20Z"}';
const API_PATH =
  '{"name":"API_PATH","period":10,"limit":50,"remaining":49,"until":"2026-08-31T11:15:20Z"}';
const GENERAL =
  '{"name":"General","period":60,"limit":1000,"remaining":999,"until":"2026-08-31T11:16:00Z"}';

const FALLBACK = 250;
const MAX_SLEEP = 30_000;

describe('parseRateBuckets', () => {
  it('parses the multi-valued header fetch joins with ", " despite the commas inside each JSON value', () => {
    const buckets = parseRateBuckets(`${API}, ${API_PATH}`);
    expect(buckets.map((b) => b.name)).toEqual(['API', 'API_PATH']);
    expect(buckets[0]?.limit).toBe(50);
    expect(buckets[1]?.remaining).toBe(49);
  });

  it('parses the 3.basecamp.com pair with its differing periods', () => {
    const buckets = parseRateBuckets(`${GENERAL}, ${API_PATH}`);
    expect(buckets.map((b) => b.period)).toEqual([60, 10]);
  });

  it('ignores a malformed segment and keeps the well-formed ones', () => {
    const buckets = parseRateBuckets(`${API}, {"name":"Broken","period":}, ${API_PATH}`);
    expect(buckets.map((b) => b.name)).toEqual(['API', 'API_PATH']);
  });

  it('drops a segment that parses but is not a rate bucket', () => {
    expect(parseRateBuckets('{"name":"X","period":0,"limit":50,"remaining":1}')).toEqual([]);
    expect(parseRateBuckets('{"period":10,"limit":50,"remaining":1}')).toEqual([]);
    expect(parseRateBuckets('{"name":"X","period":10,"limit":0,"remaining":1}')).toEqual([]);
    expect(parseRateBuckets('[1,2,3]')).toEqual([]);
  });

  it('returns nothing for an absent or empty header', () => {
    expect(parseRateBuckets(null)).toEqual([]);
    expect(parseRateBuckets('')).toEqual([]);
    expect(parseRateBuckets('   ')).toEqual([]);
  });
});

describe('pacingMs', () => {
  it('falls back to the static pace when the header yielded nothing', () => {
    expect(pacingMs([], FALLBACK, MAX_SLEEP)).toBe(FALLBACK);
    expect(pacingMs(parseRateBuckets(null), FALLBACK, MAX_SLEEP)).toBe(FALLBACK);
    expect(pacingMs(parseRateBuckets('not json at all'), FALLBACK, MAX_SLEEP)).toBe(FALLBACK);
  });

  it('paces to 80% of the observed bucket rate, agreeing with the static 250 ms by construction', () => {
    expect(pacingMs(parseRateBuckets(`${API}, ${API_PATH}`), FALLBACK, MAX_SLEEP)).toBe(250);
  });

  it('takes the slowest bucket when they disagree', () => {
    const slow = '{"name":"Slow","period":10,"limit":20,"remaining":19,"until":"x"}';
    expect(pacingMs(parseRateBuckets(`${API}, ${slow}`), FALLBACK, MAX_SLEEP)).toBe(625);
  });

  it('sits out the rest of the window at the low-water mark', () => {
    const low = '{"name":"API_PATH","period":10,"limit":50,"remaining":5,"until":"x"}';
    expect(pacingMs(parseRateBuckets(low), FALLBACK, MAX_SLEEP)).toBe(10_000);
  });

  it('does not sit out the window above the low-water mark', () => {
    const ok = '{"name":"API_PATH","period":10,"limit":50,"remaining":6,"until":"x"}';
    expect(pacingMs(parseRateBuckets(ok), FALLBACK, MAX_SLEEP)).toBe(250);
  });

  it('clamps to the maximum sleep', () => {
    const huge = '{"name":"Day","period":86400,"limit":100,"remaining":0,"until":"x"}';
    expect(pacingMs(parseRateBuckets(huge), FALLBACK, MAX_SLEEP)).toBe(MAX_SLEEP);
  });
});
