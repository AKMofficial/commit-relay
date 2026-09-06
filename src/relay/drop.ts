import type { Deps } from '../runtime/deps.ts';
import type { RelayJob } from '../core/types.ts';

/** Metric updates plus one error log; fields and event name are caller-defined. */
export function recordDrop(
  deps: Deps,
  event: string,
  fields: Record<string, unknown>,
): void {
  const now = deps.now();
  const windowOpened = deps.metrics.noteDrop(now);
  deps.log('error', event, fields);
  if (windowOpened) {
    // One line per DROP_ALERT_WINDOW_MS window: count is the opening floor; the
    // per-drop line above remains the per-commit record (7.3).
    deps.log('error', 'jobs_dropped', { count: deps.metrics.dropsInWindow(now) });
  }
}

/** A deferred job no tier can hold any longer: dropped loudly, naming the
 *  commit that would have posted next. */
export function recordDeferredDrop(
  deps: Deps,
  job: RelayJob,
  resumeAtSeq: number,
  lastStatus: number,
  extra: Record<string, unknown>,
): void {
  recordDrop(deps, 'message_dropped', {
    deliveryId: job.deliveryId,
    repo: job.repoFullName,
    // A pull request job has no commit to name, so it names itself instead.
    ...(job.type === 'push'
      ? { sha: job.commits[resumeAtSeq]?.id ?? null }
      : { sha: null, pr: job.number }),
    lastStatus,
    ...extra,
  });
}
