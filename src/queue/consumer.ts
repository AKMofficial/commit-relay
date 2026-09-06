/** The single call site of `relayPush` and `relayPullRequest` on both targets,
 *  enforced by a grep invariant, so every path shares this delivery-id dedup. */

import type { Deps } from '../runtime/deps.ts';
import { relayPullRequest, relayPush, type RelayOutcome } from '../relay/pipeline.ts';
import type { RelayJob } from '../core/types.ts';
import type { Dedup } from '../relay/dedup.ts';
import { isDeferred } from '../relay/poster.ts';

export type { RelayOutcome };
export { isDeferred };

export interface ConsumeOptions {
  /** 1 on a first delivery. */
  attempt?: number;
  dedup?: Dedup;
}

/** One function for every job type on purpose: the delivery-id block below is
 *  what the grep invariant exists to make unskippable, and a second copy of it
 *  is how the "a deferred job is recorded failed" subtlety drifts. */
export async function consumeJob(
  job: RelayJob,
  deps: Deps,
  options: ConsumeOptions = {},
): Promise<RelayOutcome> {
  const dedup = options.dedup;
  const attempt = options.attempt ?? 1;

  // Outcome-aware, never a naive GUID skip: only a completed delivery is
  // swallowed, so the operator's manual Redeliver still works (9.8).
  if (dedup !== undefined && job.deliveryId !== '' && dedup.shouldSkipDelivery(job.deliveryId)) {
    deps.log('info', 'delivery_duplicate_skipped', {
      repo: job.repoFullName,
      deliveryId: job.deliveryId,
    });
    return { posted: 0, failed: 0, skipped: 0, dropped: 0 };
  }

  const outcome =
    job.type === 'push'
      ? await relayPush(job, deps, { attempt, dedup })
      : await relayPullRequest(job, deps, { attempt, dedup });

  if (dedup !== undefined && job.deliveryId !== '') {
    // A deferred push has not finished, so it is recorded `failed`: the retry
    // must be allowed to reprocess it.
    const completed = !isDeferred(outcome) && outcome.failed === 0 && outcome.dropped === 0;
    dedup.recordDelivery(job.deliveryId, completed ? 'completed' : 'failed');
  }

  return outcome;
}
