import { describe, expect, it } from 'vitest';
import { verifySignature } from './hmac.ts';
import hmacSource from './hmac.ts?raw';
import pushNormal from '../../tests/fixtures/push.normal.json?raw';
import hmacVectorsRaw from '../../tests/fixtures/hmac-vectors.json?raw';

/** GitHub's vector secret: under the 32-character boot minimum, because this
 *  file never boots the app (15.2). */
const VECTOR_SECRET = "It's a Secret to Everybody";

/** Copied rather than imported: importing the harness would pull in the app
 *  module, and 15.2 requires this file to boot nothing. */
const COMPLIANT_SECRET = 'test-webhook-secret-0000000000000000000000000000';

const encoder = new TextEncoder();

async function sign(bodyBytes: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, buffer(bodyBytes));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

interface Vector {
  note: string;
  body: number[];
  signature: string;
}

const vectors: Vector[] = (JSON.parse(hmacVectorsRaw) as { vectors: Vector[] }).vectors;

function buffer(bytes: number[] | Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

describe('verifySignature', () => {
  it('has four committed vectors keyed on GitHub published secret', () => {
    expect(vectors).toHaveLength(4);
  });

  for (const vector of vectors) {
    it(`verifies the vector: ${vector.note}`, async () => {
      expect(await verifySignature(buffer(vector.body), vector.signature, VECTOR_SECRET)).toBe(true);
    });
  }

  it('fails when one byte anywhere in the body is flipped', async () => {
    for (const vector of vectors) {
      if (vector.body.length === 0) continue;
      for (const index of [0, vector.body.length - 1, Math.floor(vector.body.length / 2)]) {
        const flipped = [...vector.body];
        flipped[index] = (flipped[index]! ^ 0x01) & 0xff;
        expect(await verifySignature(buffer(flipped), vector.signature, VECTOR_SECRET)).toBe(false);
      }
    }
  });

  it('rejects a truncated 63-hex digest', async () => {
    const [first] = vectors;
    const truncated = first!.signature.slice(0, first!.signature.length - 1);
    expect(await verifySignature(buffer(first!.body), truncated, VECTOR_SECRET)).toBe(false);
  });

  it('rejects uppercase hex', async () => {
    const [first] = vectors;
    const upper = `sha256=${first!.signature.slice('sha256='.length).toUpperCase()}`;
    expect(await verifySignature(buffer(first!.body), upper, VECTOR_SECRET)).toBe(false);
  });

  it('rejects a missing sha256= prefix', async () => {
    const [first] = vectors;
    const bare = first!.signature.slice('sha256='.length);
    expect(await verifySignature(buffer(first!.body), bare, VECTOR_SECRET)).toBe(false);
  });

  it('rejects a legacy SHA-1 X-Hub-Signature value offered alone', async () => {
    const legacy = 'sha1=a7b4c1d2e3f405162738495a6b7c8d9e0f112233';
    expect(await verifySignature(buffer([1, 2, 3]), legacy, VECTOR_SECRET)).toBe(false);
  });

  it('rejects a null header', async () => {
    expect(await verifySignature(buffer([]), null, VECTOR_SECRET)).toBe(false);
  });

  it('returns false without throwing on a wrong-length supplied value', async () => {
    for (const header of ['sha256=', 'sha256=aa', `sha256=${'a'.repeat(128)}`]) {
      await expect(verifySignature(buffer([1]), header, VECTOR_SECRET)).resolves.toBe(false);
    }
  });

  it('verifies a 1 MB body signed byte-exactly', async () => {
    const body = new Uint8Array(1_048_576);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const sig = await sign(body, VECTOR_SECRET);
    expect(await verifySignature(buffer(body), sig, VECTOR_SECRET)).toBe(true);
    body[524_288] = (body[524_288]! ^ 0xff) & 0xff;
    expect(await verifySignature(buffer(body), sig, VECTOR_SECRET)).toBe(false);
  });

  it('never decodes the body before verifying', async () => {
    // 15.4: the primitive touches the body only through crypto.subtle.
    expect(hmacSource).not.toMatch(/JSON\.parse|TextDecoder|\.toString\(/);
    const [first] = vectors;
    expect(await verifySignature(buffer(first!.body), first!.signature, VECTOR_SECRET)).toBe(true);
  });

  it('reads no config: the module imports nothing from src/config/', () => {
    expect(hmacSource).not.toMatch(/from\s+['"][^'"]*config\//);
    expect(hmacSource).not.toMatch(/\bprocess\.env\b/);
    expect(hmacSource).not.toMatch(/secret\.length/);
  });

  it('takes the secret as an argument: the same body verifies under two secrets', async () => {
    const body = Uint8Array.from([0x7b, 0x7d]);
    const vectorSig = await sign(body, VECTOR_SECRET);
    const harnessSig = await sign(body, COMPLIANT_SECRET);
    expect(vectorSig).not.toBe(harnessSig);
    expect(await verifySignature(buffer(body), vectorSig, VECTOR_SECRET)).toBe(true);
    expect(await verifySignature(buffer(body), harnessSig, COMPLIANT_SECRET)).toBe(true);
    expect(await verifySignature(buffer(body), vectorSig, COMPLIANT_SECRET)).toBe(false);
  });

  it('the two line-ending forms of the same zen document share no digest (15.5)', async () => {
    const lf = new TextEncoder().encode('{\n  "zen": "Keep it logically awesome."\n}\n');
    const crlf = new TextEncoder().encode('{\r\n  "zen": "Keep it logically awesome."\r\n}\r\n');
    const lfSig = 'sha256=df577fbcd2839ba1e5810207d30c35b9e675731b7041d71b85aa04e20c80a2d2';
    const crlfSig = 'sha256=7541c382e4fbce973cfd198e4263744d693a3532cd992571ca76333e6d365a63';
    expect(await verifySignature(buffer(lf), lfSig, VECTOR_SECRET)).toBe(true);
    expect(await verifySignature(buffer(crlf), crlfSig, VECTOR_SECRET)).toBe(true);
    expect(await verifySignature(buffer(lf), crlfSig, VECTOR_SECRET)).toBe(false);
  });

  it('the committed push fixture verifies from its bytes on disk', async () => {
    const bytes = encoder.encode(pushNormal);
    const sig = await sign(bytes, COMPLIANT_SECRET);
    expect(await verifySignature(buffer(bytes), sig, COMPLIANT_SECRET)).toBe(true);
    // 9.2: re-serializing the same document gives different bytes, hence a
    // different digest - the reason the body is never reparsed.
    const reserialized = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(bytes))),
    );
    expect(await verifySignature(buffer(reserialized), sig, COMPLIANT_SECRET)).toBe(false);
  });
});
