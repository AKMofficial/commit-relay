/** The result is never used for authorization (11.1). */

import { NOISE_LOG_WINDOW_MS, throttled } from '../obs/log.ts';
import type { LogFn } from '../obs/log.ts';
import type { Target } from '../obs/log.ts';

export interface ClientIpOptions {
  target: Target;
  /** Node only. `0` means the socket address and X-Forwarded-For is ignored. */
  trustedProxyHops?: number;
  socketAddress?: string | null;
  log?: LogFn;
}

const UNKNOWN = 'unknown';

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/;
const RFC1918 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
/** CGNAT 100.64.0.0/10 and link-local 169.254.0.0/16: some PaaS proxies connect from these. */
const CGNAT_LINK_LOCAL = /^(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;
/** fc00::/7 (unique local) and fe80::/10 (link-local), on the first hextet. */
const PRIVATE_V6 = /^(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):/i;

/** An XFF chain is only worth reading when the hop that appended it is one of
 *  ours; a public peer means the header is the caller's own invention. */
function isPrivatePeer(address: string): boolean {
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return LOOPBACK.test(bare) || RFC1918.test(bare) || CGNAT_LINK_LOCAL.test(bare) || PRIVATE_V6.test(bare);
}

/** Every address in one IPv6 /64 is one client for rate limiting, since a single
 *  host is routinely handed the whole prefix. IPv4 and anything unparseable pass through. */
export function rateLimitKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const bare = ip.split('%')[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1] as string;
  const halves = bare.toLowerCase().split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : [];
  const fill = halves.length === 2 ? Math.max(0, 8 - head.length - tail.length) : 0;
  const hextets = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (hextets.length < 4 || !hextets.slice(0, 4).every((h) => /^[0-9a-f]{1,4}$/.test(h))) return ip;
  return `${hextets.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function forwardedEntries(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function resolveClientIp(headers: Headers, options: ClientIpOptions): string {
  const socket = options.socketAddress ?? null;

  if (options.target === 'workers') {
    // The edge sets CF-Connecting-IP and a client cannot forge it, so
    // X-Forwarded-For is never consulted on this target (11.1).
    return headers.get('cf-connecting-ip')?.trim() || socket || UNKNOWN;
  }

  const hops = options.trustedProxyHops ?? 0;
  if (hops === 0) return socket ?? UNKNOWN;
  const warnMismatch = (fields: Record<string, unknown>): void => {
    if (throttled('xff_hops_mismatch', NOISE_LOG_WINDOW_MS, Date.now())) {
      options.log?.('warn', 'xff_hops_mismatch', { hops, ...fields });
    }
  };

  if (socket === null || !isPrivatePeer(socket)) {
    warnMismatch({ reason: 'untrusted_peer' });
    return socket ?? UNKNOWN;
  }

  const entries = forwardedEntries(headers.get('x-forwarded-for'));
  if (entries.length < hops) {
    warnMismatch({ entries: entries.length });
    return socket;
  }

  return entries[entries.length - hops] ?? socket;
}
