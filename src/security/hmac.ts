// src/security/hmac.ts
// Platform-pure: no hono, no node:*, no cloudflare:*. Runs unchanged on Workers and Node 24.

import { UTF8_ENCODER } from '../core/bytes.ts';

const SIGNATURE_SHAPE = /^sha256=[0-9a-f]{64}$/;
const keyCache = new Map<string, Promise<CryptoKey>>();

/** HMAC keys are derived per secret, not per request: importKey is not free. */
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      'raw',
      UTF8_ENCODER.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keyCache.set(secret, k);
  }
  return k;
}

/** "sha256=<64 hex>" -> the 32 raw signature bytes. Shape is pre-validated. */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Verify an X-Hub-Signature-256 header against the EXACT bytes GitHub sent.
 * `rawBody` must be the unmodified request body. Never a re-serialized object.
 * Pure: the secret is an argument and NO policy is enforced on it here. Length and
 * denylist rules belong to config boot (src/config/env.ts), not to the primitive.
 */
export async function verifySignature(
  rawBody: BufferSource,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  // Cheap shape gate. Also rejects the legacy SHA-1 X-Hub-Signature format outright.
  if (signatureHeader === null || !SIGNATURE_SHAPE.test(signatureHeader)) return false;

  const signature = hexToBytes(signatureHeader.slice('sha256='.length));
  // crypto.subtle.verify is constant-time by construction: no string compare, no early exit,
  // no manual byte loop that could leak the position of the first mismatch.
  return crypto.subtle.verify('HMAC', await hmacKey(secret), signature, rawBody);
}
