import type { Deps } from '../runtime/deps.ts';
import { Sequence } from '../core/sequence.ts';
import type { PullRequestJob, PushJob, RelayResult } from '../core/types.ts';
import { enrichPush, promote } from './enricher.ts';
import {
  isDeferred,
  postPullRequestJob,
  postRollupJob,
  runPoster,
  type Deferred,
  type PostOutcome,
} from './poster.ts';
import {
  commitKey,
  pullRequestDedupKey,
  rollupKey,
  type Dedup,
} from './dedup.ts';

export type { Deferred, PostOutcome };
export { isDeferred };

export type RelayOutcome = RelayResult | Deferred;

export interface RelayOptions {
  attempt?: number;
  /** Delivery-id dedup is the consumer's job; this is the commit-level map. */
  dedup?: Dedup;
}

async function postDeduped(
  key: string,
  dedup: Dedup | undefined,
  deps: Deps,
  logEvent: string,
  logFields: Record<string, unknown>,
  post: () => Promise<PostOutcome>,
): Promise<RelayOutcome> {
  if (dedup?.hasCommit(key) === true) {
    deps.metrics.inc('skippedTotal');
    deps.log('info', logEvent, logFields);
    return { posted: 0, failed: 0, skipped: 1, dropped: 0 };
  }

  const outcome = await post();
  if (!isDeferred(outcome) && outcome.posted > 0) dedup?.recordCommit(key);
  return outcome;
}

export async function relayPush(
  job: PushJob,
  deps: Deps,
  options: RelayOptions = {},
): Promise<RelayOutcome> {
  if (job.rollup !== undefined) {
    const dedup = options.dedup;
    if (dedup !== undefined) {
      const rollupDedupKey = rollupKey(
        job.repoFullName,
        job.ref,
        job.before,
        job.after,
        job.rollup.kind,
        job.target.bucketId,
        job.target.chatId,
      );
      return postDeduped(
        rollupDedupKey,
        dedup,
        deps,
        'rollup_duplicate_skipped',
        {
          repo: job.repoFullName,
          ref: job.ref,
          deliveryId: job.deliveryId,
        },
        () => postRollupJob(job, deps, { attempt: options.attempt }),
      );
    }
    return postRollupJob(job, deps, { attempt: options.attempt });
  }

  const seq = new Sequence(job.commits);
  const resumeAtSeq = job.resumeAtSeq ?? 0;
  if (resumeAtSeq > 0) {
    for (const commit of seq.jobs) {
      if (commit.seq >= resumeAtSeq) break;
      seq.markSkipped(commit.seq);
    }
    deps.log('debug', 'push_resumed', {
      repo: job.repoFullName,
      deliveryId: job.deliveryId,
      resumeAtSeq,
    });
  }
  const dedup = options.dedup;

  if (dedup !== undefined) {
    for (const commit of seq.jobs) {
      const key = commitKey(job.repoFullName, commit.commit.id, job.target.bucketId, job.target.chatId);
      if (!dedup.hasCommit(key)) continue;
      seq.markSkipped(commit.seq);
      deps.metrics.inc('skippedTotal');
      deps.log('info', 'commit_duplicate_skipped', {
        repo: job.repoFullName,
        sha: commit.commit.id,
        deliveryId: job.deliveryId,
      });
    }
  }

  const cancel = new AbortController();
  const enriching = enrichPush(job, seq, deps, { cancel: cancel.signal }).catch((error: unknown) => {
    // Whatever happened, every pending job must reach a terminal state or the
    // ordered poster blocks on it forever.
    deps.log('error', 'enrich_failed', { repo: job.repoFullName, error: String(error) });
    for (const commit of seq.jobs) promote(job, seq, deps, commit.seq, null);
  });

  const outcome = await runPoster(job, seq, deps, {
    attempt: options.attempt,
    onPosted: (posted) => {
      dedup?.recordCommit(
        commitKey(job.repoFullName, posted.commit.id, job.target.bucketId, job.target.chatId),
      );
    },
  });

  if (isDeferred(outcome)) cancel.abort();
  await enriching;
  return outcome;
}

/** One message, so the whole pipeline is the dedup check plus the post. It sits
 *  beside `relayPush` because the queue consumer is the only caller of either. */
export async function relayPullRequest(
  job: PullRequestJob,
  deps: Deps,
  options: RelayOptions = {},
): Promise<RelayOutcome> {
  const key = pullRequestDedupKey(job, job.target.bucketId, job.target.chatId);
  return postDeduped(
    key,
    options.dedup,
    deps,
    'pull_request_duplicate_skipped',
    {
      repo: job.repoFullName,
      pr: job.number,
      deliveryId: job.deliveryId,
    },
    () => postPullRequestJob(job, deps, { attempt: options.attempt }),
  );
}
