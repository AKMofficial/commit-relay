/** [W] The degraded tier, chosen when no queue is bound (13.1 row 14): 30 shared
 *  seconds, no retries, no dead-letter queue - which beats refusing to deploy. */

import type { Deps } from '../../runtime/deps.ts';
import type { RelayJob } from '../../core/types.ts';
import { recordDeferredDrop } from '../../relay/drop.ts';
import { isDeferred, type PostOutcome } from '../../relay/poster.ts';
import type { AsyncTier } from '../types.ts';

/** Only the one ExecutionContext method needed, so the module carries no
 *  cloudflare: import and runs under both pools. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Below the platform's 30 s waitUntil budget so a slow consume is dropped with a log line. */
const WAIT_UNTIL_DEADLINE_MS = 25_000;

export class WaitUntilTier implements AsyncTier {
  private readonly ctx: WaitUntilContext;
  private readonly consume: (job: RelayJob) => Promise<PostOutcome>;
  private readonly deps: Deps;

  constructor(
    ctx: WaitUntilContext,
    consume: (job: RelayJob) => Promise<PostOutcome>,
    deps: Deps,
  ) {
    this.ctx = ctx;
    this.consume = consume;
    this.deps = deps;
  }

  enqueue(job: RelayJob): Promise<void> {
    this.ctx.waitUntil(
      Promise.race([
        this.consume(job).then((outcome) => ({ kind: 'done' as const, outcome })),
        this.deps.sleep(WAIT_UNTIL_DEADLINE_MS).then(() => ({ kind: 'timeout' as const })),
      ])
        .then((result) => {
          if (result.kind === 'timeout') {
            recordDeferredDrop(this.deps, job, job.type === 'push' ? (job.resumeAtSeq ?? 0) : 0, 0, {
              tier: 'waitUntil',
              deadline: true,
            });
            return;
          }
          if (isDeferred(result.outcome)) {
            this.dropDeferred(job, result.outcome.retryAfterS, result.outcome.resumeAtSeq, result.outcome.status);
          }
        })
        .catch((error: unknown) => {
          this.deps.log('error', 'consumer_exception', {
            repo: job.repoFullName,
            deliveryId: job.deliveryId,
            error: String(error),
          });
        }),
    );
    return Promise.resolve();
  }

  /** No queue to hand the message back to and no re-head, so a deferred job is
   *  dropped loudly rather than abandoned without a trace (13.1 row 27). */
  private dropDeferred(job: RelayJob, retryAfterS: number, resumeAtSeq: number, lastStatus: number): void {
    recordDeferredDrop(this.deps, job, resumeAtSeq, lastStatus, { tier: 'waitUntil', retryAfterS });
  }
}
