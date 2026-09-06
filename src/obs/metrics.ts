export type MetricCounter =
  | 'postedTotal'
  | 'retriedTotal'
  | 'failedTotal'
  | 'droppedTotal'
  | 'skippedTotal'
  | 'statsUnavailableTotal';

/** Epoch-millisecond timestamps and 0/1 flags, so a snapshot is uniformly numeric. */
export type MetricGauge =
  | 'queueDepth'
  | 'queueBytes'
  | 'dedupeDeliveries'
  | 'dedupeCommits'
  | 'lastDropAt'
  | 'lastPostAt'
  | 'lastBasecampStatus'
  | 'configHealthy';

export type MetricName = MetricCounter | MetricGauge;

export interface Metrics {
  inc(name: MetricCounter, by?: number): void;
  set(name: MetricGauge, value: number): void;
  snapshot(): Record<MetricName, number>;
  /** Returns whether this is the first drop of the current window, so the caller
   *  emits one `error jobs_dropped` per window, not one per drop (7.3). */
  noteDrop(now: number): boolean;
  /** Drops recorded inside the window the last `noteDrop` opened. */
  dropsInWindow(now: number): number;
}

const COUNTERS: readonly MetricCounter[] = [
  'postedTotal',
  'retriedTotal',
  'failedTotal',
  'droppedTotal',
  'skippedTotal',
  'statsUnavailableTotal',
];

const GAUGES: readonly MetricGauge[] = [
  'queueDepth',
  'queueBytes',
  'dedupeDeliveries',
  'dedupeCommits',
  'lastDropAt',
  'lastPostAt',
  'lastBasecampStatus',
  'configHealthy',
];

export interface MetricsStore extends Metrics {
  /** Answers the `recent_drops` row of the /healthz table (14.4). */
  recentDrops(windowMs: number, now: number): boolean;
  /** Workers build the store before any config exists; the first valid config sets the window. */
  setDropWindow(ms: number): void;
}

export function createMetrics(initialDropWindowMs = 300_000): MetricsStore {
  const values = {} as Record<MetricName, number>;
  for (const name of COUNTERS) values[name] = 0;
  for (const name of GAUGES) values[name] = 0;
  // A fresh process has seen no terminal Basecamp status, so it is healthy
  // until something says otherwise.
  values.configHealthy = 1;

  let dropWindowMs = initialDropWindowMs;
  let windowStart = 0;
  let windowCount = 0;

  return {
    inc(name, by = 1) {
      values[name] += by;
    },
    set(name, value) {
      values[name] = value;
    },
    snapshot() {
      return { ...values };
    },
    noteDrop(now) {
      values.droppedTotal += 1;
      values.lastDropAt = now;
      const first = windowCount === 0 || now - windowStart >= dropWindowMs;
      if (first) {
        windowStart = now;
        windowCount = 1;
      } else {
        windowCount += 1;
      }
      return first;
    },
    dropsInWindow(now) {
      if (windowCount === 0 || now - windowStart >= dropWindowMs) return 0;
      return windowCount;
    },
    recentDrops(windowMs, now) {
      return values.lastDropAt > 0 && now - values.lastDropAt < windowMs;
    },
    setDropWindow(ms) {
      dropWindowMs = ms;
    },
  };
}
