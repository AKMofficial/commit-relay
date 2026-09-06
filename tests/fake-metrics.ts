import type { MetricCounter, MetricGauge, MetricName, Metrics } from '../src/obs/metrics.ts';
import { createMetrics } from '../src/obs/metrics.ts';

const COUNTERS: MetricCounter[] = [
  'postedTotal',
  'retriedTotal',
  'failedTotal',
  'droppedTotal',
  'skippedTotal',
  'statsUnavailableTotal',
];

const GAUGES: MetricGauge[] = [
  'queueDepth',
  'queueBytes',
  'dedupeDeliveries',
  'dedupeCommits',
  'lastDropAt',
  'lastPostAt',
  'lastBasecampStatus',
  'configHealthy',
];

export interface FakeMetrics extends Metrics {
  values: Record<MetricName, number>;
}

/** Injected stand-in for src/obs/metrics.ts, so no test patches a module. */
export function createFakeMetrics(dropWindowMs = 300_000): FakeMetrics {
  const inner = createMetrics(dropWindowMs);
  const values = inner.snapshot();

  const sync = (): void => {
    const snap = inner.snapshot();
    for (const name of COUNTERS) values[name] = snap[name];
    for (const name of GAUGES) values[name] = snap[name];
  };

  return {
    values,
    inc(name, by = 1) {
      inner.inc(name, by);
      sync();
    },
    set(name, value) {
      inner.set(name, value);
      sync();
    },
    snapshot() {
      sync();
      return { ...values };
    },
    noteDrop(now) {
      const first = inner.noteDrop(now);
      sync();
      return first;
    },
    dropsInWindow(now) {
      return inner.dropsInWindow(now);
    },
  };
}
