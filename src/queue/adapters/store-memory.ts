/** A `Map` used as an LRU (insertion order is LRU order; a hit re-inserts),
 *  so a flood degrades dedup accuracy instead of memory. */

import type { Config } from '../../config/schema.ts';
import type { MetricGauge, Metrics } from '../../obs/metrics.ts';
import { byteLength } from '../../core/bytes.ts';
import { Dedup, type DeliveryOutcome, type Store } from '../../relay/dedup.ts';

/** The entry bound keeps both maps under a Worker's 128 MB isolate; this byte
 *  bound is what holds when an id is pathologically long. */
const DEFAULT_MAX_BYTES = 1_048_576;

/** Typical commit key size; the byte bound now only guards pathologically long ids. */
const BYTES_PER_ENTRY_ESTIMATE = 256;

/** Heap accounting is not observable inside the isolate, so this slot-cost
 *  estimate is a deliberate over-estimate rather than a measurement. */
const ENTRY_OVERHEAD_BYTES = 64;

export interface MemoryStoreOptions {
  maxEntries: number;
  ttlMs: number;
  maxBytes?: number;
  metrics?: Metrics;
  gauge?: MetricGauge;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  bytes: number;
}

export class MemoryStore<V> implements Store<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly metrics: Metrics | undefined;
  private readonly gauge: MetricGauge | undefined;
  private bytes = 0;

  constructor(options: MemoryStoreOptions) {
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = options.ttlMs;
    this.metrics = options.metrics;
    this.gauge = options.gauge;
  }

  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now: number): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.bytes -= existing.bytes;
    }
    const bytes = byteLength(key) + ENTRY_OVERHEAD_BYTES;
    this.entries.set(key, { value, expiresAt: now + this.ttlMs, bytes });
    this.bytes += bytes;
    this.evict(now);
    this.report();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.report();
  }

  size(): number {
    return this.entries.size;
  }

  byteSize(): number {
    return this.bytes;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) break;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (entry !== undefined) this.bytes -= entry.bytes;
    }
  }

  private report(): void {
    if (this.metrics === undefined || this.gauge === undefined) return;
    this.metrics.set(this.gauge, this.entries.size);
  }
}

export function createMemoryDedup(cfg: Config, metrics: Metrics, now: () => number): Dedup {
  const ttlMs = cfg.DEDUP_TTL_HOURS * 3_600_000;
  const maxBytes = cfg.DEDUP_MAX_ENTRIES * BYTES_PER_ENTRY_ESTIMATE;
  const deliveries: Store<DeliveryOutcome> = new MemoryStore<DeliveryOutcome>({
    maxEntries: cfg.DEDUP_MAX_ENTRIES,
    ttlMs,
    maxBytes,
    metrics,
    gauge: 'dedupeDeliveries',
  });
  const commits: Store<true> = new MemoryStore<true>({
    maxEntries: cfg.DEDUP_MAX_ENTRIES,
    ttlMs,
    maxBytes,
    metrics,
    gauge: 'dedupeCommits',
  });
  return new Dedup({ deliveries, commits, now });
}
