import { afterEach, beforeEach, vi } from 'vitest';

import { resetThrottle } from '../src/obs/log.ts';

/** Fake timers stay off: pacing is an injected `deps.sleep` (4.1, 15.4), and
 *  `workerd` freezes the observable clock outside I/O anyway. */
beforeEach(() => {
  vi.useRealTimers();
  // The auth-failure collapse (14.2) keeps module-level state; clear it so one
  // suite's terminal 401 cannot suppress the next suite's.
  resetThrottle();
});

afterEach(() => {
  vi.useRealTimers();
});
