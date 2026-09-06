/** PLATFORM-PURE. Per-invocation outbound-call budget.
 *
 * Cloudflare caps external subrequests per invocation (50 on Free, not raisable);
 * exceeding it throws an untyped `Too many subrequests.` mid-flight. Enforcing the
 * ceiling here turns that into an identifiable error the poster can defer on.
 * `limit: 0` means unlimited, which is what the Node target runs with.
 */

export class SubrequestBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`subrequest budget of ${limit} is spent for this invocation`);
    this.name = 'SubrequestBudgetExceeded';
  }
}

export interface SubrequestBudget {
  /** 0 means unlimited. */
  readonly limit: number;
  /** `Infinity` when unlimited. */
  remaining(): number;
  /** Debit one call. Returns false when nothing is left. */
  take(): boolean;
}

export function createSubrequestBudget(limit: number): SubrequestBudget {
  let used = 0;
  return {
    limit,
    remaining: () => (limit === 0 ? Number.POSITIVE_INFINITY : Math.max(0, limit - used)),
    take: () => {
      if (limit !== 0 && used >= limit) return false;
      used += 1;
      return true;
    },
  };
}

/** Wraps a fetch so every call debits the budget; a call past the ceiling rejects
 *  with `SubrequestBudgetExceeded` before reaching the platform. */
export function budgetedFetch(inner: typeof fetch, budget: SubrequestBudget): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!budget.take()) return Promise.reject(new SubrequestBudgetExceeded(budget.limit));
    return inner(input, init);
  }) as typeof fetch;
}
