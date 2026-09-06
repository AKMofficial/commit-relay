/** The composition root. It sits above config/ and obs/ because it wires them
 *  together, so nothing in either folder may import it back. */

import type { Config } from '../config/schema.ts';
import { loggerFor, type LogFn, type Target } from '../obs/log.ts';
import type { Metrics } from '../obs/metrics.ts';
import { sleep } from '../core/sleep.ts';
import {
  budgetedFetch,
  createSubrequestBudget,
  type SubrequestBudget,
} from '../core/subrequests.ts';

export interface Deps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: LogFn;
  metrics: Metrics;
  now: () => number; // logging timestamps only, never pacing
  config: Config;
  /** Every call through `fetchImpl` debits this. */
  subrequests: SubrequestBudget;
}

/** The one production wiring, shared by both entrypoints. Unlimited subrequests:
 *  the ceiling is per Workers invocation, so the worker applies it per job with
 *  `withSubrequestBudget` rather than on this long-lived object. */
export function createDeps(config: Config, target: Target, metrics: Metrics): Deps {
  return {
    // Bound: an unbound global fetch throws "Illegal invocation" the moment it
    // is called through a field reference.
    fetchImpl: globalThis.fetch.bind(globalThis),
    sleep,
    log: loggerFor(config, target),
    metrics,
    now: Date.now,
    config,
    subrequests: createSubrequestBudget(0),
  };
}

/** A copy of `deps` whose fetch debits a fresh budget of `limit` calls. */
export function withSubrequestBudget(deps: Deps, limit: number): Deps {
  const subrequests = createSubrequestBudget(limit);
  return { ...deps, subrequests, fetchImpl: budgetedFetch(deps.fetchImpl, subrequests) };
}
