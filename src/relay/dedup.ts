/** Two maps sized independently, so delivery-id churn can never evict a commit
 *  entry (11.1). The delivery id is unsigned; the commit key is authoritative. */

/** GitHub keeps a manual redelivery button for 3 days, so a naive GUID skip
 *  would swallow the operator's retry at exactly the moment they need it (9.8). */
export type DeliveryOutcome = 'completed' | 'failed';

/** `now` is passed in rather than read, so TTL is testable without a global. */
export interface Store<V> {
  get(key: string, now: number): V | undefined;
  set(key: string, value: V, now: number): void;
  delete(key: string): void;
  size(): number;
}

export interface DedupStores {
  deliveries: Store<DeliveryOutcome>;
  commits: Store<true>;
  now: () => number;
}

import type { PullRequestJob, RollupKind } from '../core/types.ts';

export function commitKey(
  repoFullName: string,
  sha: string,
  bucketId: string,
  chatId: string,
): string {
  return `${repoFullName}|${sha}|${bucketId}|${chatId}`;
}

export function rollupKey(
  repoFullName: string,
  ref: string,
  before: string,
  after: string,
  kind: RollupKind,
  bucketId: string,
  chatId: string,
): string {
  return `${repoFullName}|${ref}|${before}|${after}|${kind}|${bucketId}|${chatId}`;
}

/** Namespaced with a literal so it cannot collide with a `commitKey`: both land
 *  in the same commit map. The head sha separates two runs of the same action on
 *  a pull request that moved on; the action separates opened from merged. */
export function pullRequestKey(
  repoFullName: string,
  number: number,
  kind: string,
  headSha: string,
  bucketId: string,
  chatId: string,
): string {
  return `${repoFullName}|pr#${number}|${kind}|${headSha}|${bucketId}|${chatId}`;
}

/** Review ids are unique and immutable, so they need nothing else. */
export function pullRequestReviewKey(
  repoFullName: string,
  reviewId: number,
  bucketId: string,
  chatId: string,
): string {
  return `${repoFullName}|prreview#${reviewId}|${bucketId}|${chatId}`;
}

export function pullRequestDedupKey(job: PullRequestJob, bucketId: string, chatId: string): string {
  return job.reviewId === undefined
    ? pullRequestKey(
        job.repoFullName,
        job.number,
        job.kind,
        job.headSha,
        bucketId,
        chatId,
      )
    : pullRequestReviewKey(job.repoFullName, job.reviewId, bucketId, chatId);
}

export class Dedup {
  private readonly stores: DedupStores;

  constructor(stores: DedupStores) {
    this.stores = stores;
  }

  deliveryOutcome(deliveryId: string): DeliveryOutcome | undefined {
    return this.stores.deliveries.get(deliveryId, this.stores.now());
  }

  /** `failed`, and an id that fell out of the bounded map, are both reprocessed. */
  shouldSkipDelivery(deliveryId: string): boolean {
    return this.deliveryOutcome(deliveryId) === 'completed';
  }

  recordDelivery(deliveryId: string, outcome: DeliveryOutcome): void {
    this.stores.deliveries.set(deliveryId, outcome, this.stores.now());
  }

  hasCommit(key: string): boolean {
    return this.stores.commits.get(key, this.stores.now()) === true;
  }

  recordCommit(key: string): void {
    this.stores.commits.set(key, true, this.stores.now());
  }

  sizes(): { deliveries: number; commits: number } {
    return { deliveries: this.stores.deliveries.size(), commits: this.stores.commits.size() };
  }
}
