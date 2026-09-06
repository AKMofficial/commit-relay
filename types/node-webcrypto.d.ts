// Node-project-only. @types/node exposes `CryptoKey` as a value but keeps the
// type inside the `webcrypto` namespace, so the platform-pure
// `Promise<CryptoKey>` in src/security/hmac.ts has no global type name to
// resolve to. This file is reachable from tsconfig.node.json only; the Workers
// project includes src/** alone and gets the name from the generated wrangler types.
import type { webcrypto } from 'node:crypto';

declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type BufferSource = ArrayBufferView | ArrayBuffer;
}

export {};
