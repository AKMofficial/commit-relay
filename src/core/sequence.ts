/** The cursor advances past every terminal state and blocks only on `pending`,
 *  so a merge commit confirmed after enrichment cannot deadlock the queue (9.8). */

import type { CommitJob, CommitStats, NormalizedCommit } from './types.ts';

export type JobState = CommitJob['state'];

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['posted', 'failed', 'skipped']);

function isTerminal(state: JobState): boolean {
  return TERMINAL.has(state);
}

interface SequenceCounts {
  pending: number;
  ready: number;
  posted: number;
  failed: number;
  skipped: number;
}

export class Sequence {
  private readonly items: CommitJob[];
  private waiters: Array<() => void> = [];
  private cursor = 0;

  constructor(commits: readonly NormalizedCommit[]) {
    this.items = commits.map((commit, seq) => ({ seq, commit, state: 'pending', stats: null }));
  }

  get jobs(): readonly CommitJob[] {
    return this.items;
  }

  get(seq: number): CommitJob | undefined {
    return this.items[seq];
  }

  /** A late resolution against a non-`pending` job is discarded, which is what
   *  makes the enrichment deadline safe (failure row 20). */
  markReady(seq: number, stats: CommitStats | null): boolean {
    const job = this.items[seq];
    if (job === undefined || job.state !== 'pending') return false;
    job.stats = stats === null ? null : { additions: stats.additions, deletions: stats.deletions };
    if (stats !== null) job.parentsCount = stats.parentsCount;
    job.state = 'ready';
    this.notify();
    return true;
  }

  markSkipped(seq: number): boolean {
    return this.toTerminal(seq, 'skipped');
  }

  markPosted(seq: number): boolean {
    return this.toTerminal(seq, 'posted');
  }

  markFailed(seq: number): boolean {
    return this.toTerminal(seq, 'failed');
  }

  /** Null when the lowest non-terminal job is still `pending`: the poster waits. */
  nextPostable(): CommitJob | null {
    while (this.cursor < this.items.length) {
      const job = this.items[this.cursor];
      if (job === undefined || !isTerminal(job.state)) break;
      this.cursor += 1;
    }
    const job = this.items[this.cursor];
    if (job === undefined || job.state !== 'ready') return null;
    return job;
  }

  allDone(): boolean {
    return this.items.every((job) => isTerminal(job.state));
  }

  counts(): SequenceCounts {
    const out: SequenceCounts = { pending: 0, ready: 0, posted: 0, failed: 0, skipped: 0 };
    for (const job of this.items) out[job.state] += 1;
    return out;
  }

  /** The poster parks here instead of polling, so no clock is read in the
   *  pacing path (4.1). */
  changed(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private toTerminal(seq: number, state: JobState): boolean {
    const job = this.items[seq];
    if (job === undefined || isTerminal(job.state)) return false;
    job.state = state;
    this.notify();
    return true;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
