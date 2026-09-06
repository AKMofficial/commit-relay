/** [N] THE CONTRACT IS AT-MOST-ONCE: nothing here is durable, and a push lost to
 *  process death is never redelivered (13.1 rows 29-30, 16.2.3). Bounded at
 *  ingest by depth and bytes; enqueued jobs are never evicted (11.1). */

import { byteLength } from '../../core/bytes.ts';
import type { Deps } from '../../runtime/deps.ts';
import type { RelayJob } from '../../core/types.ts';
import { recordDeferredDrop } from '../../relay/drop.ts';
import { isDeferred, type PostOutcome } from '../../relay/poster.ts';
import { QueueFullError } from '../types.ts';
import type { AsyncTier } from '../types.ts';

/** Passed to the runner, not just held by the tier: `drain` promotes pending
 *  enrichment with `stats: null` rather than starting a GitHub call. */
export type RunMode = 'normal' | 'drain';

export type RunJob = (job: RelayJob, mode: RunMode) => Promise<PostOutcome>;

export interface MemoryFifoOptions {
  deps: Deps;
  run: RunJob;
  maxDepth: number;
  maxBytes: number;
  retryAfterSeconds?: number;
  /** `RATELIMIT_WAIT_BUDGET_MS`: wall time a job may spend deferred on 429s before
   *  it is dropped (13.1 row 27). */
  rateLimitBudgetMs?: number;
  /** The Node mirror of the queue's `max_retries: 5`. */
  maxAttempts?: number;
}

export interface DrainReport {
  posted: number;
  dropped: number;
  /** Named so a lost push can be redelivered by hand (13.1 row 30). */
  remaining: string[];
  jobs: number;
}

interface Entry {
  job: RelayJob;
  bytes: number;
  attempts: number;
  waitedMs: number;
}

export class MemoryFifoTier implements AsyncTier {
  private readonly deps: Deps;
  private readonly run: RunJob;
  private readonly maxDepth: number;
  private readonly maxBytes: number;
  private readonly retryAfterSeconds: number;
  private readonly rateLimitBudgetMs: number;
  private readonly maxAttempts: number;
  private readonly entries: Entry[] = [];
  private bytes = 0;
  private posted = 0;
  private dropped = 0;
  private running = false;
  private draining = false;
  private idle: Promise<void> = Promise.resolve();
  private markIdle: () => void = () => {};

  constructor(options: MemoryFifoOptions) {
    this.deps = options.deps;
    this.run = options.run;
    this.maxDepth = options.maxDepth;
    this.maxBytes = options.maxBytes;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 10;
    this.rateLimitBudgetMs = options.rateLimitBudgetMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  depth(): number {
    return this.entries.length;
  }

  byteSize(): number {
    return this.bytes;
  }

  enqueue(job: RelayJob): Promise<void> {
    if (this.draining) {
      return Promise.reject(
        new QueueFullError('draining', this.entries.length, this.bytes, this.retryAfterSeconds),
      );
    }
    const bytes = byteLength(JSON.stringify(job));
    if (this.entries.length + 1 > this.maxDepth) {
      return Promise.reject(
        new QueueFullError('depth', this.entries.length, this.bytes, this.retryAfterSeconds),
      );
    }
    if (this.bytes + bytes > this.maxBytes) {
      return Promise.reject(
        new QueueFullError('bytes', this.entries.length, this.bytes, this.retryAfterSeconds),
      );
    }

    this.entries.push({ job, bytes, attempts: 0, waitedMs: 0 });
    this.bytes += bytes;
    this.report();
    this.kick();
    return Promise.resolve();
  }

  /** Finishes the in-flight post, then keeps posting at the normal pace until
   *  the queue is empty or the deadline expires (16.2.3 step 3). */
  async drain(deadlineMs: number): Promise<DrainReport> {
    this.draining = true;
    const postedBefore = this.posted;
    const droppedBefore = this.dropped;
    this.kick();
    await Promise.race([this.idle, this.deps.sleep(deadlineMs)]);
    return {
      posted: this.posted - postedBefore,
      dropped: this.dropped - droppedBefore,
      // Only a push names shas; a pull request job is reported by the count.
      remaining: this.entries.flatMap((entry) =>
        entry.job.type === 'push' ? entry.job.commits.map((commit) => commit.id) : [],
      ),
      jobs: this.entries.length,
    };
  }

  /** The pump starts on the next scheduler turn, never inside `enqueue`, so the
   *  webhook's 202 is written before any outbound call is made (9.3 gate 10). */
  private kick(): void {
    if (this.running) return;
    this.running = true;
    this.idle = new Promise<void>((resolve) => {
      this.markIdle = resolve;
    });
    void this.deps.sleep(0).then(() => this.pump());
  }

  private async pump(): Promise<void> {
    for (;;) {
      const entry = this.entries[0];
      if (entry === undefined) break;

      let outcome: PostOutcome;
      try {
        outcome = await this.run(entry.job, this.draining ? 'drain' : 'normal');
      } catch (error) {
        // At-most-once: a job that threw is not retried.
        this.deps.log('error', 'consumer_exception', {
          repo: entry.job.repoFullName,
          deliveryId: entry.job.deliveryId,
          error: String(error),
        });
        this.shift();
        this.dropped += 1;
        continue;
      }

      if (isDeferred(outcome)) {
        // A drain never waits out a rate limit: the deadline is shorter than the
        // wait would be, and the job is named in drain_incomplete instead.
        if (this.draining) break;
        const waitMs = outcome.retryAfterS * 1000;
        entry.attempts += 1;
        // Sum of granted waits, not a clock delta: workerd freezes the clock
        // outside I/O and the accounting must match on both targets (4.1).
        if (entry.attempts >= this.maxAttempts || entry.waitedMs + waitMs > this.rateLimitBudgetMs) {
          this.dropDeferred(entry, outcome.resumeAtSeq, outcome.status);
          continue;
        }
        entry.waitedMs += waitMs;
        this.deps.metrics.inc('retriedTotal');
        await this.deps.sleep(waitMs);
        continue;
      }

      this.posted += outcome.posted;
      this.dropped += outcome.dropped;
      this.shift();
    }

    this.running = false;
    this.markIdle();
  }

  /** Dropped, never re-headed forever: an unbounded re-head pins the FIFO and
   *  every later push is shed with a 503 while nothing says why (13.1 row 27). */
  private dropDeferred(entry: Entry, resumeAtSeq: number, lastStatus: number): void {
    recordDeferredDrop(this.deps, entry.job, resumeAtSeq, lastStatus, {
      attempts: entry.attempts,
      waitedMs: entry.waitedMs,
    });
    this.shift();
    this.dropped += 1;
  }

  private shift(): void {
    const entry = this.entries.shift();
    if (entry !== undefined) this.bytes -= entry.bytes;
    this.report();
  }

  private report(): void {
    this.deps.metrics.set('queueDepth', this.entries.length);
    this.deps.metrics.set('queueBytes', this.bytes);
  }
}
