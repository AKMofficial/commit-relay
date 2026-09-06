/** Bounded-lookahead enrichment: at most `GITHUB_CONCURRENCY` fetches in flight,
 *  so commit 1 can post while commit 8 is still fetching. */

import type { Deps } from '../runtime/deps.ts';
import type { CommitStats, PushJob } from '../core/types.ts';
import { resolveStatsMode } from '../github/token.ts';
import type { Sequence } from '../core/sequence.ts';
import { fetchCommitStats } from '../github/stats.ts';
import { splitFullName } from '../github/url.ts';

export interface EnrichOptions {
  /** Aborted when the poster deferred: the retry would redo these fetches
   *  anyway, and they cost subrequests. */
  cancel?: AbortSignal;
}

/** `auto` resolves on token presence, which is the only thing that makes the
 *  call useful: an unauthenticated commit read of a private repo returns 404. */
function statsOn(mode: 'auto' | 'on' | 'off', token: string | null): boolean {
  return resolveStatsMode(mode, token !== null && token !== '') === 'on';
}

export async function enrichPush(
  push: PushJob,
  seq: Sequence,
  deps: Deps,
  options: EnrichOptions = {},
): Promise<void> {
  const cfg = deps.config;
  const name = splitFullName(push.repoFullName);

  if (!statsOn(cfg.FETCH_LINE_STATS, push.target.githubToken) || name === null) {
    for (const job of seq.jobs) promote(push, seq, deps, job.seq, null);
    return;
  }

  const controllers = new Map<number, AbortController>();
  let stopped = false;
  let cursor = 0;
  let pause: Promise<void> | null = null;
  let finished = false;

  const stop = (evt: string, extra: Record<string, unknown> = {}): void => {
    stopped = true;
    for (const controller of controllers.values()) controller.abort();
    for (const job of seq.jobs) {
      if (job.state !== 'pending') continue;
      deps.log('warn', evt, {
        ...extra,
        repo: push.repoFullName,
        sha: job.commit.id,
        deliveryId: push.deliveryId,
      });
      promote(push, seq, deps, job.seq, null);
    }
  };

  const deadline = deps.sleep(cfg.ENRICH_DEADLINE_MS).then(() => {
    if (finished) return;
    stop('stats_deadline');
  });

  const cancelled = (): boolean => stopped || options.cancel?.aborted === true;

  // Stats are optional, the POSTs are not: reserve one call per commit plus a rollup (12.3).
  const postReserve = seq.jobs.length + 1;
  const statsAffordable = (): boolean => deps.subrequests.remaining() > postReserve;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled()) return;
      const index = cursor;
      cursor += 1;
      const job = seq.get(index);
      if (job === undefined) return;
      if (job.state !== 'pending') continue;

      if (pause !== null) await pause;
      if (cancelled()) return;

      if (!statsAffordable()) {
        deps.metrics.inc('statsUnavailableTotal');
        stop('stats_skipped', { reason: 'subrequest_budget' });
        return;
      }

      const controller = new AbortController();
      controllers.set(job.seq, controller);
      const outcome = await fetchCommitStats(
        {
          owner: name.owner,
          repo: name.repo,
          sha: job.commit.id,
          deliveryId: push.deliveryId,
          apiBase: push.target.githubApiBase,
          token: push.target.githubToken,
          userAgent: cfg.USER_AGENT,
          timeoutMs: cfg.GITHUB_TIMEOUT_MS,
          maxBytes: cfg.GITHUB_STATS_MAX_BYTES,
          signal: controller.signal,
        },
        deps,
      );
      controllers.delete(job.seq);

      if (outcome.pauseMs !== undefined && outcome.pauseMs > 0) {
        // One shared pause for every worker: GitHub's limit is per token, not
        // per request, so racing the reset window just burns the retry budget.
        const waiting = deps.sleep(outcome.pauseMs).then(() => {
          if (pause === waiting) pause = null;
        });
        pause = waiting;
      }

      if (outcome.stats === null) deps.metrics.inc('statsUnavailableTotal');
      promote(push, seq, deps, job.seq, outcome.stats);
    }
  };

  const workers: Array<Promise<void>> = [];
  const width = Math.min(cfg.GITHUB_CONCURRENCY, Math.max(1, seq.jobs.length));
  for (let i = 0; i < width; i += 1) workers.push(worker());

  try {
    await Promise.race([Promise.all(workers), deadline]);
  } finally {
    finished = true;
    for (const controller of controllers.values()) controller.abort();
  }
}

/** `markReady` refuses a job that is no longer pending, so a late resolution is
 *  discarded here rather than resurrecting a force-promoted job (row 20). */
export function promote(
  push: PushJob,
  seq: Sequence,
  deps: Deps,
  seqNo: number,
  stats: CommitStats | null,
): void {
  if (!seq.markReady(seqNo, stats)) return;
  const job = seq.get(seqNo);
  if (job === undefined) return;

  // When stats ran, `parentsCount` is authoritative; otherwise the ingest-time
  // `Merge branch` prefix hint applies (9.8).
  const isMerge =
    job.parentsCount !== undefined
      ? job.parentsCount > 1
      : job.commit.mergeCandidate === true;
  if (push.options.skipMergeCommits && isMerge) {
    seq.markSkipped(seqNo);
    deps.metrics.inc('skippedTotal');
    deps.log('info', 'push_skipped', {
      reason: 'merge_commit',
      repo: push.repoFullName,
      sha: job.commit.id,
      deliveryId: push.deliveryId,
    });
  }
}
