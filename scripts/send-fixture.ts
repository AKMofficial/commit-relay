// scripts/send-fixture.ts
import { readFile } from 'node:fs/promises';

const [file, target = 'http://127.0.0.1:8787/webhook'] = process.argv.slice(2);
const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!file || !secret) {
  console.error('usage: GITHUB_WEBHOOK_SECRET=... pnpm send:fixture <file> [url]');
  process.exit(2);
}

const body = await readFile(file);                     // exact bytes; never JSON.parse
const key = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
);
const mac = await crypto.subtle.sign('HMAC', key, body);
const sig = 'sha256=' + [...new Uint8Array(mac)]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

const res = await fetch(target, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'user-agent': 'GitHub-Hookshot/local',
    'x-github-event': process.env.EVENT ?? 'push',
    'x-github-delivery': crypto.randomUUID(),
    'x-hub-signature-256': sig,
  },
  body,
});
console.log(res.status, await res.text());
