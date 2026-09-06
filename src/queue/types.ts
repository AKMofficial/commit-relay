import type { RelayJob } from '../core/types.ts';

/** Seam 1 (4.3): nothing upstream knows which of the three tiers is live. */
export interface AsyncTier {
  enqueue(job: RelayJob): Promise<void>;
}

export type QueueFullReason = 'depth' | 'bytes' | 'draining';

/** The webhook turns this into `503` + `Retry-After` (13.1 row 12): the red X on
 *  the hook page is what makes the operator's only recovery path discoverable. */
export class QueueFullError extends Error {
  readonly reason: QueueFullReason;
  readonly depth: number;
  readonly bytes: number;
  readonly retryAfterSeconds: number;

  constructor(reason: QueueFullReason, depth: number, bytes: number, retryAfterSeconds: number) {
    super(`queue is full (${reason})`);
    this.name = 'QueueFullError';
    this.reason = reason;
    this.depth = depth;
    this.bytes = bytes;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isQueueFullError(error: unknown): error is QueueFullError {
  return error instanceof QueueFullError;
}
