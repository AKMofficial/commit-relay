/** The only pacing primitive: a duration, never a deadline (10.3). */

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
