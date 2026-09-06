/** One commit at a time in strict `seq` order, paced with `await deps.sleep()`
 *  and never a clock delta (4.1). */

import { flipsConfigHealth } from '../basecamp/classify.ts';
import { postLine } from '../basecamp/client.ts';
import type { BasecampTarget, PosterConfig, PostResult } from '../basecamp/types.ts';
import type { Deps } from '../runtime/deps.ts';
import type { Sequence } from '../core/sequence.ts';
import type { CommitJob, JobBase, PullRequestJob, PushJob, RelayResult } from '../core/types.ts';
import { throttled } from '../obs/log.ts';
import { buildCommitTable, buildRollupTable } from '../render/message.ts';
import { ContentUnrenderableError, type RenderLimits } from '../render/table.ts';
import { buildPullRequestTable } from '../render/pull-request.ts';
import { redactOutbound } from '../security/redact.ts';
import { recordDrop } from './drop.ts';

/** A rate limit or retry-budget deferral. The poster never sleeps it out: an
 *  invocation held asleep is the expensive way to wait. */
export interface Deferred {
  deferred: true;
  retryAfterS: number;
  resumeAtSeq: number;
  status: number;
}

export type PostOutcome = RelayResult | Deferred;

export function isDeferred(outcome: PostOutcome): outcome is Deferred {
  return 'deferred' in outcome;
}

export interface PosterOptions {
  attempt?: number;
  onPosted?: (job: CommitJob) => void;
}

/** What the send helpers actually read off a job. Narrowed so the commit,
 *  rollup and pull-request paths share one send-and-report block. */
type Postable = Pick<JobBase, 'deliveryId' | 'repoFullName' | 'target'>;

function renderLimits(deps: Deps, push: Postable): RenderLimits {
  return {
    bodyMaxCodePoints: deps.config.COMMIT_BODY_MAX_CHARS,
    contentMaxBytes: deps.config.CONTENT_MAX_BYTES,
    webOrigin: push.target.webOrigin,
  };
}

function posterConfig(deps: Deps): PosterConfig {
  const cfg = deps.config;
  return {
    userAgent: cfg.USER_AGENT,
    timeoutMs: cfg.BASECAMP_TIMEOUT_MS,
    minIntervalMs: cfg.BASECAMP_MIN_INTERVAL_MS,
    maxSleepMs: cfg.BASECAMP_MAX_SLEEP_MS,
    contentMaxBytes: cfg.CONTENT_MAX_BYTES,
    postRetryBudgetMs: cfg.POST_RETRY_BUDGET_MS,
    rateLimitWaitBudgetMs: cfg.RATELIMIT_WAIT_BUDGET_MS,
  };
}

function basecampTarget(push: Postable): BasecampTarget {
  return {
    apiBase: push.target.apiBase,
    accountId: push.target.accountId,
    chatbotKey: push.target.chatbotKey,
    bucketId: push.target.bucketId,
    chatId: push.target.chatId,
  };
}

interface PosterSendContext {
  target: BasecampTarget;
  config: PosterConfig;
}

function sendContext(push: Postable, deps: Deps): PosterSendContext {
  return { target: basecampTarget(push), config: posterConfig(deps) };
}

interface PostedLine {
  sha: string | null;
  seq: number;
  attempt: number;
  extra?: Record<string, unknown>;
}

/** One send plus the metrics and `message_posted` line every success records,
 *  so the commit and rollup paths cannot drift on what they report. */
async function postContent(
  content: string,
  ctx: PosterSendContext,
  deps: Deps,
  push: Postable,
  line: PostedLine,
): Promise<PostResult> {
  const startedAt = deps.now();
  // The precision-tuned pass, not redactText: the log rules would rewrite
  // ordinary commit prose in the room (11.1).
  const result = await postLine(redactOutbound(content), ctx.target, ctx.config, {
    fetch: deps.fetchImpl,
    sleep: deps.sleep,
    log: deps.log,
  });
  deps.metrics.set('lastBasecampStatus', result.status);
  if (result.ok) {
    deps.metrics.inc('postedTotal');
    deps.metrics.set('lastPostAt', deps.now());
    deps.log('info', 'message_posted', {
      deliveryId: push.deliveryId,
      repo: push.repoFullName,
      sha: line.sha,
      seq: line.seq,
      ms: deps.now() - startedAt,
      attempt: line.attempt,
      ...line.extra,
    });
  }
  return result;
}

function recordFatal(result: PostResult, push: Postable, line: PostedLine, deps: Deps): void {
  deps.metrics.inc('failedTotal');
  recordDrop(deps, 'message_dropped', {
    deliveryId: push.deliveryId,
    repo: push.repoFullName,
    sha: line.sha,
    lastStatus: result.status,
    ...line.extra,
  });
  if (!flipsConfigHealth(result.status)) return;
  // Row 25: a rotated key is otherwise invisible - every push still returns 202
  // and the room simply goes quiet - so this is what pages an operator.
  deps.metrics.set('configHealthy', 0);
  // Collapsed to once per repo per hour, not once per commit (14.2).
  if (!throttled(`auth:${push.repoFullName}`, 3_600_000, deps.now())) return;
  deps.log('error', 'basecamp_terminal', {
    deliveryId: push.deliveryId,
    repo: push.repoFullName,
    status: result.status,
  });
  deps.log('error', 'config_unhealthy', {
    deliveryId: push.deliveryId,
    repo: push.repoFullName,
    status: result.status,
  });
}

function recordContentDrop(
  push: Postable,
  sha: string | null,
  deps: Deps,
  extra: Record<string, unknown> = {},
): void {
  recordDrop(deps, 'content_unrenderable', {
    deliveryId: push.deliveryId,
    repo: push.repoFullName,
    sha,
    ...extra,
  });
}

export async function runPoster(
  push: PushJob,
  seq: Sequence,
  deps: Deps,
  options: PosterOptions = {},
): Promise<PostOutcome> {
  const limits = renderLimits(deps, push);
  const attempt = options.attempt ?? 1;
  const sendCtx = sendContext(push, deps);
  let posted = 0;
  let failed = 0;
  let dropped = 0;

  for (;;) {
    const job = seq.nextPostable();
    if (job === null) {
      if (seq.allDone()) break;
      await seq.changed();
      continue;
    }

    let content: string;
    try {
      content = buildCommitTable(
        {
          repoFullName: push.repoFullName,
          refKind: push.refKind,
          refName: push.refName,
          author: job.commit.authorUsername ?? job.commit.authorName,
          fileCount: job.commit.fileCount,
          additions: job.stats?.additions ?? null,
          deletions: job.stats?.deletions ?? null,
          message: job.commit.message,
          commitUrl: job.commit.url,
        },
        limits,
      );
    } catch (error) {
      if (!(error instanceof ContentUnrenderableError)) throw error;
      recordContentDrop(push, job.commit.id, deps);
      seq.markFailed(job.seq);
      dropped += 1;
      continue;
    }

    const result = await postContent(content, sendCtx, deps, push, {
      sha: job.commit.id,
      seq: job.seq,
      attempt,
    });

    if (result.ok) {
      seq.markPosted(job.seq);
      posted += 1;
      options.onPosted?.(job);
    } else if (!result.fatal) {
      return { deferred: true, retryAfterS: result.retryAfterS ?? 1, resumeAtSeq: job.seq, status: result.status };
    } else {
      seq.markFailed(job.seq);
      failed += 1;
      dropped += 1;
      recordFatal(result, push, { sha: job.commit.id, seq: job.seq, attempt }, deps);
    }

    await deps.sleep(result.pacingMs);
  }

  return { posted, failed, skipped: seq.counts().skipped, dropped };
}

/** No GitHub call at all: not fetching per-commit stats is the saving the
 *  rollup exists for (9.8). */
export async function postRollupJob(
  push: PushJob,
  deps: Deps,
  options: PosterOptions = {},
): Promise<PostOutcome> {
  const rollup = push.rollup;
  if (rollup === undefined) return { posted: 0, failed: 0, skipped: 0, dropped: 0 };

  let content: string;
  try {
    content = buildRollupTable(
      {
        kind: rollup.kind,
        repoFullName: push.repoFullName,
        refKind: push.refKind,
        refName: push.refName,
        fileCount: rollup.fileCount,
        authors: rollup.authors,
        compareUrl: push.compareUrl,
      },
      renderLimits(deps, push),
    );
  } catch (error) {
    if (!(error instanceof ContentUnrenderableError)) throw error;
    recordContentDrop(push, null, deps, { rollup: rollup.kind });
    return { posted: 0, failed: 0, skipped: 0, dropped: 1 };
  }

  return postSingle(content, push, deps, {
    sha: null,
    seq: 0,
    attempt: options.attempt ?? 1,
    extra: { rollup: rollup.kind },
  });
}

/** One message, no GitHub call, no ordering to keep: the whole terminal ladder
 *  a single-post job needs. `resumeAtSeq` is 0 because there is no partial
 *  progress to resume from; a deferral replays the job whole. */
async function postSingle(
  content: string,
  job: Postable,
  deps: Deps,
  line: PostedLine,
): Promise<PostOutcome> {
  const result = await postContent(content, sendContext(job, deps), deps, job, line);

  if (result.ok) {
    await deps.sleep(result.pacingMs);
    return { posted: 1, failed: 0, skipped: 0, dropped: 0 };
  }

  if (!result.fatal) {
    return { deferred: true, retryAfterS: result.retryAfterS ?? 1, resumeAtSeq: 0, status: result.status };
  }

  recordFatal(result, job, line, deps);
  await deps.sleep(result.pacingMs);
  return { posted: 0, failed: 1, skipped: 0, dropped: 1 };
}

/** The line counts arrive in the webhook payload, so this path makes no GitHub
 *  subrequest at all. */
export async function postPullRequestJob(
  job: PullRequestJob,
  deps: Deps,
  options: PosterOptions = {},
): Promise<PostOutcome> {
  let content: string;
  try {
    content = buildPullRequestTable({ ...job, baseRef: job.refName }, renderLimits(deps, job));
  } catch (error) {
    if (!(error instanceof ContentUnrenderableError)) throw error;
    recordContentDrop(job, null, deps, { pr: job.number });
    return { posted: 0, failed: 0, skipped: 0, dropped: 1 };
  }

  return postSingle(content, job, deps, {
    sha: null,
    seq: 0,
    attempt: options.attempt ?? 1,
    extra: { pr: job.number, prKind: job.kind },
  });
}
