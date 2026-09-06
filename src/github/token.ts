/** Token isolation (9.6, 11.1): a route naming its own variable never falls back
 *  to the global one, because falling back defeats the isolation it provides. */

export type StatsMode = 'on' | 'off';

/** `auto` alone consults the token: without one a private repo 404s every
 *  request, so it degrades to off rather than spending one per commit. */
export function resolveStatsMode(setting: 'auto' | 'on' | 'off', tokenPresent: boolean): StatsMode {
  if (setting === 'off') return 'off';
  if (setting === 'on') return 'on';
  return tokenPresent ? 'on' : 'off';
}

/** True when REQUIRE_LINE_STATS is set but stats would silently be off, which
 *  is the boot failure that flag exists to produce (9.5). */
export function requireLineStatsViolated(
  requireLineStats: boolean,
  setting: 'auto' | 'on' | 'off',
  tokenPresent: boolean,
): boolean {
  return requireLineStats && resolveStatsMode(setting, tokenPresent) === 'off';
}
