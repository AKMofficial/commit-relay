/** [W] Retries, ordering and the dead-letter queue are the platform's; the only
 *  thing this module owns is the 128 KB message ceiling. */

import type { Deps } from '../../runtime/deps.ts';
import { byteLength } from '../../core/bytes.ts';
import type { RelayJob, QueuedJob } from '../../core/types.ts';
import { rollupAuthors, toQueuedJob } from '../../core/types.ts';
import { recordDrop } from '../../relay/drop.ts';
import type { AsyncTier } from '../types.ts';

/** https://developers.cloudflare.com/queues/platform/limits/ */
const QUEUE_MESSAGE_MAX_BYTES = 131_072;

export interface SizedJob {
  job: RelayJob;
  bytes: number;
  oversize: boolean;
}

/** Above the ceiling, collapse to the `cap` rollup of 8.4 - the same degradation
 *  an over-cap push reaches by another route, not a fourth RollupKind. */
export function capOversizeJob(job: RelayJob, maxBytes = QUEUE_MESSAGE_MAX_BYTES): SizedJob {
  const bytes = byteLength(JSON.stringify(job));
  if (bytes <= maxBytes) return { job, bytes, oversize: false };

  // Only the title of a pull request job can grow (COMMIT_BODY_MAX_CHARS allows
  // 100k code points). Dropping it leaves the link, which is the renderer's own
  // level-2 fallback; collapsing to a `cap` rollup would invent a push.
  if (job.type !== 'push') {
    const untitled = { ...job, title: '' };
    return { job: untitled, bytes: byteLength(JSON.stringify(untitled)), oversize: true };
  }

  const collapsed: RelayJob = {
    ...job,
    commits: [],
    rollup: {
      kind: 'cap',
      fileCount: job.rollup?.fileCount ?? job.changedPathCount ?? null,
      authors: job.rollup?.authors ?? rollupAuthors(job.commits),
    },
  };
  return { job: collapsed, bytes: byteLength(JSON.stringify(collapsed)), oversize: true };
}

export class CfQueueTier implements AsyncTier {
  private readonly queue: Queue<QueuedJob>;
  private readonly deps: Deps;
  private readonly maxBytes: number;

  constructor(queue: Queue<QueuedJob>, deps: Deps, maxBytes = QUEUE_MESSAGE_MAX_BYTES) {
    this.queue = queue;
    this.deps = deps;
    this.maxBytes = maxBytes;
  }

  async enqueue(job: RelayJob): Promise<void> {
    const sized = capOversizeJob(job, this.maxBytes);
    if (sized.oversize) {
      this.deps.log('warn', 'queue_message_oversize', {
        repo: job.repoFullName,
        ref: job.refName,
        bytes: sized.bytes,
        limit: this.maxBytes,
        // A push collapses to a rollup, a pull request loses its title; see capOversizeJob.
        commits: job.type === 'push' ? job.commits.length : 0,
      });
      // `bytes` is re-measured after the collapse. If the fixed fields alone are
      // over the ceiling the send would throw a non-QueueFullError and 500 to
      // GitHub, so drop it loudly here instead: the job is unsendable, not queued.
      if (sized.bytes > this.maxBytes) {
        recordDrop(this.deps, 'message_dropped', {
          deliveryId: job.deliveryId,
          repo: job.repoFullName,
          sha: null,
          ...(job.type === 'push' ? {} : { pr: job.number }),
          bytes: sized.bytes,
          limit: this.maxBytes,
          reason: 'queue_message_unsendable',
        });
        return;
      }
    }
    await this.queue.send(toQueuedJob(sized.job));
  }
}
