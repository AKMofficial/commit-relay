export type LifecycleState = 'starting' | 'ready' | 'draining' | 'closed';

export interface Lifecycle {
  state(): LifecycleState;
  /** `/healthz` answers 503 in every state but `ready`, so a booting or draining
   *  instance never tells a green lie (14.4, 16.2.3 step 1). */
  isServing(): boolean;
  ready(): void;
  /** Returns false when a drain is already under way, which is how a second
   *  SIGTERM is made a no-op rather than a second drain. */
  drain(): boolean;
  close(): void;
}

const ORDER: readonly LifecycleState[] = ['starting', 'ready', 'draining', 'closed'];

export function createLifecycle(): Lifecycle {
  let state: LifecycleState = 'starting';

  // The machine only ever moves forward: a late `ready()` from a slow boot
  // callback must not resurrect a draining process.
  const advance = (next: LifecycleState): boolean => {
    if (ORDER.indexOf(next) <= ORDER.indexOf(state)) return false;
    state = next;
    return true;
  };

  return {
    state: () => state,
    isServing: () => state === 'ready',
    ready: () => void advance('ready'),
    drain: () => advance('draining'),
    close: () => void advance('closed'),
  };
}
