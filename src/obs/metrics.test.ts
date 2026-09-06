import { describe, expect, it } from 'vitest';
import { createMetrics } from './metrics.ts';

describe('createMetrics', () => {
  it('starts every counter and gauge at zero, healthy', () => {
    const snapshot = createMetrics().snapshot();
    expect(snapshot.postedTotal).toBe(0);
    expect(snapshot.droppedTotal).toBe(0);
    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.lastPostAt).toBe(0);
    expect(snapshot.configHealthy).toBe(1);
  });

  it('increments counters by one or by an explicit amount and sets gauges', () => {
    const m = createMetrics();
    m.inc('postedTotal');
    m.inc('postedTotal', 4);
    m.set('queueDepth', 7);
    m.set('configHealthy', 0);
    expect(m.snapshot().postedTotal).toBe(5);
    expect(m.snapshot().queueDepth).toBe(7);
    expect(m.snapshot().configHealthy).toBe(0);
  });

  it('returns a copy, so a caller cannot mutate the store', () => {
    const m = createMetrics();
    const snapshot = m.snapshot();
    snapshot.postedTotal = 99;
    expect(m.snapshot().postedTotal).toBe(0);
  });

  it('reports the first drop of each window and counts the rest', () => {
    const m = createMetrics(300_000);
    expect(m.noteDrop(1_000)).toBe(true);
    expect(m.noteDrop(2_000)).toBe(false);
    expect(m.noteDrop(3_000)).toBe(false);
    expect(m.dropsInWindow(3_000)).toBe(3);
    expect(m.snapshot().droppedTotal).toBe(3);
    expect(m.snapshot().lastDropAt).toBe(3_000);

    expect(m.noteDrop(301_001)).toBe(true);
    expect(m.dropsInWindow(301_001)).toBe(1);
    expect(m.snapshot().droppedTotal).toBe(4);
  });

  it('answers recentDrops over the supplied window only', () => {
    const m = createMetrics();
    expect(m.recentDrops(300_000, 1_000)).toBe(false);
    m.noteDrop(1_000);
    expect(m.recentDrops(300_000, 200_000)).toBe(true);
    expect(m.recentDrops(300_000, 301_000)).toBe(false);
    expect(m.recentDrops(1_000, 2_000)).toBe(false);
  });
});
