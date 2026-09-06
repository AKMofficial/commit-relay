/** The result is never used for authorization (11.1). */

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

/** An XFF chain is only worth reading when the hop that appended it is one of
 *  ours; a public peer means the header is the caller's own invention. */
function isPrivatePeer(address: string): boolean {
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return LOOPBACK.test(bare) || RFC1918.test(bare) || bare.startsWith('fc') || bare.startsWith('fd');
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

  if (socket === null || !isPrivatePeer(socket)) {
    options.log?.('warn', 'xff_hops_mismatch', { hops, reason: 'untrusted_peer' });
    return socket ?? UNKNOWN;
  }

  const entries = forwardedEntries(headers.get('x-forwarded-for'));
  if (entries.length < hops) {
    options.log?.('warn', 'xff_hops_mismatch', { hops, entries: entries.length });
    return socket;
  }

  return entries[entries.length - hops] ?? socket;
}
