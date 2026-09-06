import { describe, expect, it, vi } from 'vitest';
import { app } from './app.ts';
import { resolveClientIp } from './clientip.ts';
import { createWebhookHandler, pathnameOf } from './webhook.ts';
import type { RelayJob } from '../core/types.ts';
import { asPush } from '../../tests/push-job.ts';
import type { AsyncTier } from '../queue/types.ts';
import { QueueFullError } from '../queue/types.ts';
import { verifySignature } from '../security/hmac.ts';
import type { LogFn } from '../obs/log.ts';
import { createEnv, createCtx, HARNESS_SECRET, loadFixture, post, sign } from '../../tests/harness.ts';

import unknownFields from '../../tests/fixtures/push.unknown-fields.json?raw';
import large from '../../tests/fixtures/push.large.json?raw';
import branchCreate from '../../tests/fixtures/push.branch-create.json?raw';
import forced from '../../tests/fixtures/push.forced.json?raw';
import tag from '../../tests/fixtures/push.tag.json?raw';
import tagWithCommits from '../../tests/fixtures/push.tag-with-commits.json?raw';
import branchDelete from '../../tests/fixtures/push.branch-delete.json?raw';
import emptyPush from '../../tests/fixtures/push.empty.json?raw';
import merge from '../../tests/fixtures/push.merge.json?raw';
import nonDistinct from '../../tests/fixtures/push.non-distinct.json?raw';
import bot from '../../tests/fixtures/push.bot.json?raw';
import injection from '../../tests/fixtures/push.injection.json?raw';
import astral from '../../tests/fixtures/push.astral.json?raw';
import prOpened from '../../tests/fixtures/pr.opened.json?raw';
import reviewApproved from '../../tests/fixtures/review.approved.json?raw';

const PUSH = loadFixture('push.normal.json');

const encoder = new TextEncoder();

/** 15.5: the signature is over the committed file exactly as GitHub sent it. */
function fixture(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

const FIXTURES: Record<string, string> = {
  large,
  branchCreate,
  forced,
  tag,
  tagWithCommits,
  branchDelete,
  emptyPush,
  merge,
  nonDistinct,
  bot,
  injection,
  astral,
  unknownFields,
};

function toBuffer(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface Line {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function recorder(): { log: LogFn; lines: Line[] } {
  const lines: Line[] = [];
  return { log: (level, event, fields) => void lines.push({ level, event, fields }), lines };
}

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function recorder_tier(): { jobs: RelayJob[]; tier: AsyncTier } {
  const jobs: RelayJob[] = [];
  return {
    jobs,
    tier: {
      enqueue(job) {
        jobs.push(job);
        return Promise.resolve();
      },
    },
  };
}

function handler(over: Partial<Parameters<typeof createWebhookHandler>[0]> = {}) {
  const { tier } = recorder_tier();
  return createWebhookHandler({ target: 'node', resolveTier: () => tier, ...over });
}

function handlerWith(tier: AsyncTier, over: Partial<Parameters<typeof createWebhookHandler>[0]> = {}) {
  return createWebhookHandler({ target: 'node', resolveTier: () => tier, ...over });
}

function request(path: string, init: RequestInit & { duplex?: string } = {}) {
  return new Request(`https://relay.example${path}`, init as RequestInit);
}

async function signedInit(bytes: Uint8Array<ArrayBuffer>, over: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': crypto.randomUUID(),
      'x-hub-signature-256': await sign(bytes, HARNESS_SECRET),
      ...over,
    },
    body: bytes,
  } satisfies RequestInit;
}

describe('POST /webhook through the booted app', () => {
  it('accepts the committed fixture signed byte-exactly', async () => {
    const res = await post(PUSH, await sign(PUSH, HARNESS_SECRET));
    expect(res.status).toBe(202);
  });

  it('returns 401 with a fixed body that never says why', async () => {
    const wrong = await sign(PUSH, 'another-secret-0000000000000000000000000000000000');
    const res = await post(PUSH, wrong);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
  });

  it('passes Content-Type: application/json; charset=utf-8 on a prefix match', async () => {
    const init = await signedInit(PUSH, { 'content-type': 'application/json; charset=utf-8' });
    const { ctx } = createCtx();
    const res = await app.request('/webhook', init, createEnv(), ctx);
    expect(res.status).toBe(202);
  });

  it('returns 415 for application/x-www-form-urlencoded', async () => {
    const init = await signedInit(PUSH, { 'content-type': 'application/x-www-form-urlencoded' });
    const { ctx } = createCtx();
    const res = await app.request('/webhook', init, createEnv(), ctx);
    expect(res.status).toBe(415);
  });

  it('answers ping with 204 and any non-push event with 204', async () => {
    for (const event of ['ping', 'issues', 'workflow_run']) {
      const init = await signedInit(PUSH, { 'x-github-event': event, 'x-github-hook-id': '42' });
      const { ctx } = createCtx();
      const res = await app.request('/webhook', init, createEnv(), ctx);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
    }
  });

  it('404s a path that is not WEBHOOK_PATH and honours a configured one', async () => {
    const init = await signedInit(PUSH);
    const { ctx } = createCtx();
    expect((await app.request('/nope', init, createEnv(), ctx)).status).toBe(404);
    const custom = createEnv({ WEBHOOK_PATH: '/gh/hook' });
    expect((await app.request('/webhook', init, custom, ctx)).status).toBe(404);
    expect((await app.request('/gh/hook', await signedInit(PUSH), custom, ctx)).status).toBe(202);
  });

  it('returns 503 and /healthz 500 when the webhook secret fails the boot rules', async () => {
    // 15.2: a secret valid for the primitive but invalid for a deployment.
    const env = createEnv({ GITHUB_WEBHOOK_SECRET: "It's a Secret to Everybody" });
    const { ctx } = createCtx();
    const res = await app.request('/webhook', await signedInit(PUSH), env, ctx);
    expect(res.status).toBe(503);
    const health = await app.request('/healthz', {}, env, ctx);
    expect(health.status).toBe(500);
    expect(await health.json()).toMatchObject({ status: 'config_invalid' });
  });

  it('keeps /healthz answering 200 alongside the webhook route', async () => {
    const { ctx } = createCtx();
    const res = await app.request('/healthz', {}, createEnv(), ctx);
    expect(res.status).toBe(200);
  });
});

describe('gate ordering', () => {
  it('415s without ever calling the verifier', async () => {
    const verify = vi.fn(async () => true);
    const res = await handler({ verify }).call(
      null,
      request('/webhook', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
      createEnv(),
    );
    expect(res.status).toBe(415);
    expect(verify).not.toHaveBeenCalled();
  });

  it('logs webhook_bad_content_type with its own event, not a signature failure', async () => {
    const { log, lines } = recorder();
    const res = await handler({ log, verify: async () => true })(
      request('/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'payload=%7B%7D',
      }),
      createEnv(),
    );
    expect(res.status).toBe(415);
    const evts = lines.map((l) => l.event);
    expect(evts).toContain('webhook_bad_content_type');
    expect(evts).not.toContain('webhook_signature_invalid');
    expect(lines.find((l) => l.event === 'webhook_bad_content_type')?.fields?.['hint']).toBeTruthy();
  });

  it('returns its response before any injected fetch is invoked', async () => {
    const calls: Request[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return new Response('', { status: 201 });
    };
    const tier: AsyncTier = {
      enqueue() {
        setTimeout(() => void fetchImpl('https://api.github.com/x'), 0);
        return Promise.resolve();
      },
    };
    const res = await handlerWith(tier)(request('/webhook', await signedInit(PUSH)), createEnv());
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(1);
  });

  it('400s a missing X-GitHub-Event after the signature verified', async () => {
    const init = await signedInit(PUSH);
    const headers = { ...init.headers } as Record<string, string>;
    delete headers['x-github-event'];
    const res = await handler()(
      request('/webhook', { method: 'POST', headers, body: PUSH }),
      createEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('400s unparseable JSON that carried a valid signature', async () => {
    const junk = new TextEncoder().encode('{ not json at all');
    const res = await handler()(
      request('/webhook', await signedInit(junk)),
      createEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('parses the same bytes it verified, never a re-serialization', async () => {
    const { jobs, tier } = recorder_tier();
    await handlerWith(tier)(request('/webhook', await signedInit(PUSH)), createEnv());
    expect(jobs[0]?.repoFullName).toBe('your-org/your-repo');

    const altered = new TextEncoder().encode(new TextDecoder().decode(PUSH) + ' ');
    const init = await signedInit(PUSH);
    const res = await handler()(
      request('/webhook', { ...init, body: altered }),
      createEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('carries the delivery id through to the enqueued job', async () => {
    const init = await signedInit(PUSH, {
      'x-github-delivery': '11111111-2222-3333-4444-555555555555',
    });
    const { jobs, tier } = recorder_tier();
    await handlerWith(tier)(request('/webhook', init), createEnv());
    expect(jobs[0]?.deliveryId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('treats an oversized X-GitHub-Delivery as absent and does not store it in dedup', async () => {
    const huge = 'a'.repeat(10_240);
    const init = await signedInit(PUSH, { 'x-github-delivery': huge });
    const { jobs, tier } = recorder_tier();
    const res = await handlerWith(tier)(request('/webhook', init), createEnv());
    expect(res.status).toBe(202);
    expect(jobs[0]?.deliveryId).toBe('');
  });

  it('logs webhook_delivery_id_invalid once per hour for malformed delivery ids', async () => {
    const { log, lines } = recorder();
    const init = await signedInit(PUSH, { 'x-github-delivery': 'not-a-uuid' });
    await handler({ log })(request('/webhook', init), createEnv());
    expect(lines.filter((l) => l.event === 'webhook_delivery_id_invalid')).toHaveLength(1);
  });
});

describe('the size cap', () => {
  it('413s on a Content-Length above MAX_BODY_BYTES without reading the body', async () => {
    const verify = vi.fn(async () => true);
    const res = await handler({ verify })(
      request('/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '99999999' },
        body: PUSH,
      }),
      createEnv({ MAX_BODY_BYTES: '4096' }),
    );
    expect(res.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  it('413s a chunked body without buffering all of it', async () => {
    const CHUNK = new Uint8Array(64 * 1024).fill(0x61);
    const TOTAL_CHUNKS = 1600;
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(CHUNK.slice());
      },
      cancel() {
        cancelled = true;
      },
    });

    const verify = vi.fn(async () => true);
    const res = await handler({ verify })(
      request('/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      }),
      createEnv({ MAX_BODY_BYTES: '1048576' }),
    );

    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(pulled).toBeLessThan(64);
    expect(pulled * CHUNK.byteLength).toBeLessThan(100 * 1024 * 1024);
  });
  it('413s through the composed app on the 26 MB hono/body-limit mount', async () => {
    const CHUNK = new Uint8Array(64 * 1024).fill(0x61);
    const NEEDED = Math.ceil(27 * 1024 * 1024 / CHUNK.byteLength);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= NEEDED) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(CHUNK.slice());
      },
    });
    const { ctx } = createCtx();
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => void printed.push(String(line)));
    let res: Response;
    try {
      res = await app.request(
        '/webhook',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
          body: stream,
          duplex: 'half',
        } as RequestInit,
        createEnv(),
        ctx,
      );
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(NEEDED);
    // Failure row 5: the bodyLimit mount must not swallow gate 3's log line.
    expect(printed.join('\n')).toContain('webhook_body_too_large');
  });

  it('mounts the composed body limit at the configured MAX_BODY_BYTES', async () => {
    const CHUNK = new Uint8Array(4096).fill(0x61);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 64) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(CHUNK.slice());
      },
    });
    const { ctx } = createCtx();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let res: Response;
    try {
      res = await app.request(
        '/webhook',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
          body: stream,
          duplex: 'half',
        } as RequestInit,
        createEnv({ MAX_BODY_BYTES: '8192' }),
        ctx,
      );
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(64);
  });
});

describe('gate 1: the rate limiter', () => {
  it('429s the RATE_LIMIT_PER_MINUTE + 1-th request with Retry-After and no verify call', async () => {
    const verify = vi.fn(async () => true);
    const c = clock();
    const h = handler({ verify, now: c.now, socketAddress: () => '203.0.113.9' });
    const env = createEnv({ RATE_LIMIT_PER_MINUTE: '3' });
    for (let i = 0; i < 3; i++) {
      const res = await h(request('/webhook', await signedInit(PUSH)), env);
      expect(res.status).toBe(202);
    }
    expect(verify).toHaveBeenCalledTimes(3);

    const limited = await h(request('/webhook', await signedInit(PUSH)), env);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('caps a flood spread across a thousand forged addresses at the global bucket', async () => {
    const verify = vi.fn(async () => false);
    const c = clock();
    let peer = '10.0.0.1';
    const h = handler({ verify, now: c.now, socketAddress: () => peer });
    const env = createEnv({ RATE_LIMIT_PER_MINUTE: '2' });
    let limited = 0;
    for (let i = 0; i < 1000; i++) {
      peer = `198.51.${Math.floor(i / 256)}.${i % 256}`;
      const res = await h(
        request('/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: PUSH }),
        env,
      );
      if (res.status === 429) limited++;
    }
    expect(limited).toBe(800);
  });

  it('an unsigned flood from a thousand addresses cannot 429 a signed delivery', async () => {
    const c = clock();
    let peer = '10.0.0.1';
    const h = handler({ now: c.now, socketAddress: () => peer });
    const env = createEnv({ RATE_LIMIT_PER_MINUTE: '2' });
    for (let i = 0; i < 1000; i++) {
      peer = `198.51.${Math.floor(i / 256)}.${i % 256}`;
      await h(
        request('/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: PUSH }),
        env,
      );
    }
    peer = '140.82.115.1';
    const res = await h(request('/webhook', await signedInit(PUSH)), env);
    expect(res.status).toBe(202);
  });

  it('a forged X-Forwarded-For cannot mint a fresh bucket at TRUSTED_PROXY_HOPS=0', async () => {
    const c = clock();
    const h = handler({ log: recorder().log, now: c.now, socketAddress: () => '203.0.113.7' });
    const env = createEnv({ RATE_LIMIT_PER_MINUTE: '2', TRUSTED_PROXY_HOPS: '0' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const init = await signedInit(PUSH, { 'x-forwarded-for': `1.2.3.${i}` });
      statuses.push((await h(request('/webhook', init), env)).status);
    }
    expect(statuses).toEqual([202, 202, 429, 429]);
  });
});

describe('resolveClientIp', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it('uses CF-Connecting-IP on Workers and never consults X-Forwarded-For', () => {
    const ip = resolveClientIp(
      headers({ 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }),
      { target: 'workers', trustedProxyHops: 2, socketAddress: '172.16.0.1' },
    );
    expect(ip).toBe('198.51.100.4');
  });

  it('ignores X-Forwarded-For entirely at TRUSTED_PROXY_HOPS=0', () => {
    const ip = resolveClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), {
      target: 'node',
      trustedProxyHops: 0,
      socketAddress: '127.0.0.1',
    });
    expect(ip).toBe('127.0.0.1');
  });

  it('counts from the right at TRUSTED_PROXY_HOPS=2', () => {
    const ip = resolveClientIp(headers({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1, 2.2.2.2' }), {
      target: 'node',
      trustedProxyHops: 2,
      socketAddress: '10.0.0.5',
    });
    expect(ip).toBe('1.1.1.1');
  });

  it('falls back to the socket address and warns when the header is too short', () => {
    const { log, lines } = recorder();
    const ip = resolveClientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
      target: 'node',
      trustedProxyHops: 2,
      socketAddress: '192.168.1.10',
      log,
    });
    expect(ip).toBe('192.168.1.10');
    expect(lines).toEqual([
      { level: 'warn', event: 'xff_hops_mismatch', fields: { hops: 2, entries: 1 } },
    ]);
  });

  it('refuses to read X-Forwarded-For when the socket peer is public', () => {
    const { log, lines } = recorder();
    const ip = resolveClientIp(headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }), {
      target: 'node',
      trustedProxyHops: 1,
      socketAddress: '203.0.113.50',
      log,
    });
    expect(ip).toBe('203.0.113.50');
    expect(lines[0]).toMatchObject({ event: 'xff_hops_mismatch', fields: { reason: 'untrusted_peer' } });
  });

  it('treats an IPv4-mapped loopback peer as private', () => {
    const ip = resolveClientIp(headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), {
      target: 'node',
      trustedProxyHops: 1,
      socketAddress: '::ffff:127.0.0.1',
    });
    expect(ip).toBe('2.2.2.2');
  });
});

describe('authentication logging', () => {
  const bad = 'sha256=' + 'a'.repeat(64);

  async function reject(over: Record<string, string>, log: ReturnType<typeof recorder>['log']) {
    return handler({ log, socketAddress: () => '203.0.113.11' })(
      request('/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...over },
        body: PUSH,
      }),
      createEnv(),
    );
  }

  it('distinguishes missing, malformed, and invalid in the log while the caller sees one 401', async () => {
    for (const [over, evt] of [
      [{}, 'webhook_signature_missing'],
      [{ 'x-hub-signature-256': 'sha1=deadbeef' }, 'webhook_signature_malformed'],
      [{ 'x-hub-signature-256': bad }, 'webhook_signature_invalid'],
    ] as const) {
      const { log, lines } = recorder();
      const res = await reject(over, log);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('unauthorized');
      expect(lines.map((l) => l.event)).toContain(evt);
    }
  });

  it('pins its shape classifier to the one hmac.ts enforces', async () => {
    const edges = [
      'sha1=' + 'a'.repeat(40),
      'sha256=' + 'A'.repeat(64),
      'sha256=' + 'a'.repeat(63),
      'sha256=' + 'g'.repeat(64),
      'a'.repeat(64),
      'sha256=' + 'a'.repeat(64) + 'a',
    ];
    for (const header of edges) {
      const { log, lines } = recorder();
      await reject({ 'x-hub-signature-256': header }, log);
      expect(lines.map((l) => l.event)).toContain('webhook_signature_malformed');
      expect(await verifySignature(toBuffer(PUSH), header, HARNESS_SECRET)).toBe(false);
    }
    const { log, lines } = recorder();
    await reject({ 'x-hub-signature-256': bad }, log);
    expect(lines.map((l) => l.event)).toContain('webhook_signature_invalid');
    expect(await verifySignature(toBuffer(PUSH), bad, HARNESS_SECRET)).toBe(false);
  });

  it('never logs the supplied header or a computed digest', async () => {
    const { log, lines } = recorder();
    await reject({ 'x-hub-signature-256': bad }, log);
    expect(JSON.stringify(lines)).not.toContain(bad.slice('sha256='.length));
  });

  it('collapses repeated failures to one line per client IP per hour', async () => {
    const c = clock();
    const { log, lines } = recorder();
    const h = handler({ log, now: c.now, socketAddress: () => '203.0.113.12' });
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': bad },
      body: PUSH,
    } satisfies RequestInit;

    for (let i = 0; i < 5; i++) await h(request('/webhook', init), createEnv({ RATE_LIMIT_PER_MINUTE: '1000' }));
    expect(lines.filter((l) => l.event === 'webhook_signature_invalid')).toHaveLength(1);

    c.advance(3_600_001);
    await h(request('/webhook', init), createEnv({ RATE_LIMIT_PER_MINUTE: '1000' }));
    expect(lines.filter((l) => l.event === 'webhook_signature_invalid')).toHaveLength(2);
  });

  it('logs rate_limited with the resolved client IP, and webhook_body_too_large on the cap', async () => {
    const { log, lines } = recorder();
    const h = handler({ log, now: clock().now, socketAddress: () => '203.0.113.13' });
    const env = createEnv({ RATE_LIMIT_PER_MINUTE: '1' });
    await h(request('/webhook', await signedInit(PUSH)), env);
    await h(request('/webhook', await signedInit(PUSH)), env);
    expect(lines.find((l) => l.event === 'rate_limited')?.fields).toMatchObject({ ip: '203.0.113.13' });

    const { log: log2, lines: lines2 } = recorder();
    await handler({ log: log2 })(
      request('/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '99999999' },
        body: PUSH,
      }),
      createEnv({ MAX_BODY_BYTES: '4096' }),
    );
    expect(lines2.map((l) => l.event)).toContain('webhook_body_too_large');
  });

  it('logs webhook_ping, event_ignored, and payload_unparseable at their spec levels', async () => {
    const { log, lines } = recorder();
    const h = handler({ log });
    await h(
      request('/webhook', await signedInit(PUSH, { 'x-github-event': 'ping', 'x-github-hook-id': '9' })),
      createEnv(),
    );
    await h(request('/webhook', await signedInit(PUSH, { 'x-github-event': 'issues' })), createEnv());
    const junk = new TextEncoder().encode('}{');
    await h(request('/webhook', await signedInit(junk)), createEnv());

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'info', event: 'webhook_ping' }),
        expect.objectContaining({ level: 'debug', event: 'event_ignored' }),
        expect.objectContaining({ level: 'error', event: 'payload_unparseable' }),
      ]),
    );
  });
});

describe('gate 9: payload shape', () => {
  it('422s a payload whose consumed paths are missing, and never 400s it', async () => {
    const broken = new TextEncoder().encode(JSON.stringify({ ref: 'refs/heads/main' }));
    const { lines, log } = recorder();
    const res = await handler({ log })(request('/webhook', await signedInit(broken)), createEnv());
    expect(res.status).toBe(422);
    expect(lines.find((l) => l.event === 'payload_unrecognized')?.level).toBe('warn');
  });

  it('processes a payload carrying unknown top-level and per-commit keys', async () => {
    const bytes = fixture(unknownFields);
    const { jobs, tier } = recorder_tier();
    const res = await handlerWith(tier)(request('/webhook', await signedInit(bytes)), createEnv());
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(1);
  });
});

describe('gate 10: filter, route, enqueue', () => {
  it('answers 202 for every committed push fixture', async () => {
    for (const [name, text] of Object.entries(FIXTURES)) {
      // 9.4: fixtures omitting `sender` are genuine gate-9 rejects.
      if (!Object.hasOwn(JSON.parse(text) as object, 'sender')) continue;
      const bytes = fixture(text);
      const env = createEnv({ BRANCHES: 'main,release/**', TAGS: 'v*' });
      const res = await handler()(request('/webhook', await signedInit(bytes)), env);
      expect([name, res.status]).toEqual([name, 202]);
    }
  });

  it('logs push_skipped with every pattern tried when the branch is not allowed', async () => {
    const { lines, log } = recorder();
    const { jobs, tier } = recorder_tier();
    const env = createEnv({ BRANCHES: 'main' });
    const res = await handlerWith(tier, { log })(
      request('/webhook', await signedInit(fixture(branchCreate))),
      env,
    );
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(0);
    const skipped = lines.find((l) => l.event === 'push_skipped');
    expect(skipped?.level).toBe('info');
    expect(skipped?.fields).toMatchObject({ reason: 'branch_not_allowed', patternsTried: ['main'] });
  });

  it('selects the cap, branch_create and forced rollups', async () => {
    const cases: Array<[string, string]> = [
      ['cap', large],
      ['branch_create', branchCreate],
      ['forced', forced],
    ];
    for (const [kind, text] of cases) {
      const { jobs, tier } = recorder_tier();
      const env = createEnv({ BRANCHES: 'main,release/**' });
      await handlerWith(tier)(request('/webhook', await signedInit(fixture(text))), env);
      expect([kind, asPush(jobs[0]!).rollup?.kind]).toEqual([kind, kind]);
      expect(asPush(jobs[0]!).commits).toEqual([]);
    }
  });

  it('counts rollup files as a union of paths and authors as distinct names', async () => {
    const { jobs, tier } = recorder_tier();
    await handlerWith(tier)(
      request('/webhook', await signedInit(fixture(forced))),
      createEnv({ BRANCHES: 'main' }),
    );
    const rollup = asPush(jobs[0]!).rollup;
    const payload = JSON.parse(forced) as {
      commits: Array<{ added: string[]; removed: string[]; modified: string[] }>;
    };
    const union = new Set(
      payload.commits.flatMap((c) => [...c.added, ...c.removed, ...c.modified]),
    );
    expect(rollup?.fileCount).toBe(union.size);
    expect(rollup?.authors).toEqual([...new Set(rollup?.authors ?? [])]);
  });

  it('enqueues nothing and logs forced_push when SKIP_FORCED_PUSHES is on', async () => {
    const { lines, log } = recorder();
    const { jobs, tier } = recorder_tier();
    const env = createEnv({ SKIP_FORCED_PUSHES: 'true' });
    const res = await handlerWith(tier, { log })(
      request('/webhook', await signedInit(fixture(forced))),
      env,
    );
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(0);
    expect(lines.find((l) => l.event === 'push_skipped')?.fields).toMatchObject({
      reason: 'forced_push',
    });
  });

  it('carries the sanitized commits and the resolved target into the job', async () => {
    const { jobs, tier } = recorder_tier();
    await handlerWith(tier)(request('/webhook', await signedInit(PUSH)), createEnv());
    const job = asPush(jobs[0]!);
    expect(job.commits).toHaveLength(3);
    expect(job.refName).toBe('main');
    expect(job.refKind).toBe('branch');
    expect(job?.target.bucketId).toBe('2345678');
    expect(job?.options.maxCommitsPerPush).toBe(15);
  });

  it('sheds a full queue with 503 and Retry-After, and logs queue_overflow', async () => {
    const { lines, log } = recorder();
    const full: AsyncTier = {
      enqueue() {
        return Promise.reject(new QueueFullError('depth', 0, 0, 10));
      },
    };
    const res = await handlerWith(full, { log })(
      request('/webhook', await signedInit(PUSH)),
      createEnv(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('10');
    const overflow = lines.find((l) => l.event === 'queue_overflow');
    expect(overflow?.level).toBe('error');
    expect(overflow?.fields).toMatchObject({ repo: 'your-org/your-repo', ref: 'refs/heads/main' });
  });
});

describe('per-route webhookSecretEnv', () => {
  const ROUTE_SECRET = 'route-a-secret-000000000000000000000000000000';

  function routedEnv(over: Record<string, unknown> = {}) {
    return createEnv({
      ROUTES: JSON.stringify({
        routes: [{ repo: 'your-org/*', webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_ORGA' }],
      }),
      GITHUB_WEBHOOK_SECRET_ORGA: ROUTE_SECRET,
      ...over,
    });
  }

  it('401s before decidePush when the global secret signs a route-bound repo, with no push_skipped', async () => {
    for (const body of [PUSH, fixture(branchCreate)]) {
      const { lines, log } = recorder();
      const { jobs, tier } = recorder_tier();
      const init = await signedInit(body, {
        'x-hub-signature-256': await sign(body, HARNESS_SECRET),
      });
      const res = await handlerWith(tier, { log })(request('/webhook', init), routedEnv({ BRANCHES: 'main' }));
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('unauthorized');
      expect(jobs).toHaveLength(0);
      expect(lines.some((l) => l.event === 'push_skipped')).toBe(false);
    }
  });

  it('still 202-skips a repo that matches no route when signed correctly', async () => {
    const { lines, log } = recorder();
    const { jobs, tier } = recorder_tier();
    const alien = new TextEncoder().encode(
      JSON.stringify({
        ...JSON.parse(new TextDecoder().decode(PUSH)),
        repository: {
          ...JSON.parse(new TextDecoder().decode(PUSH)).repository,
          full_name: 'unknown-org/unknown-repo',
          name: 'unknown-repo',
          owner: { login: 'unknown-org' },
        },
      }),
    );
    const init = await signedInit(alien, { 'x-hub-signature-256': await sign(alien, HARNESS_SECRET) });
    const res = await handlerWith(tier, { log })(request('/webhook', init), routedEnv());
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(0);
    expect(lines.some((l) => l.event === 'push_skipped' && l.fields?.['reason'] === 'no_route')).toBe(true);
  });

  it('returns the same 401 body as gate-4 signature failure on a route mismatch', async () => {
    const gate4 = await handler()(
      request('/webhook', await signedInit(PUSH, { 'x-hub-signature-256': 'sha256=' + 'b'.repeat(64) })),
      createEnv(),
    );
    const routeMismatch = await handler()(
      request('/webhook', await signedInit(PUSH)),
      routedEnv(),
    );
    expect(routeMismatch.status).toBe(gate4.status);
    expect(await routeMismatch.text()).toBe(await gate4.text());
  });

  it('accepts a delivery signed with the route secret the repo resolves to', async () => {
    const env = routedEnv();
    const { jobs, tier } = recorder_tier();
    const init = await signedInit(PUSH, { 'x-hub-signature-256': await sign(PUSH, ROUTE_SECRET) });
    const res = await handlerWith(tier)(request('/webhook', init), env);
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(1);
  });

  it('401s a delivery signed with a different route secret', async () => {
    const { lines, log } = recorder();
    const { jobs, tier } = recorder_tier();
    // 11.1: the signature is genuine but belongs to a different route.
    const res = await handlerWith(tier, { log })(
      request('/webhook', await signedInit(PUSH)),
      routedEnv(),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
    expect(jobs).toHaveLength(0);
    expect(lines.find((l) => l.event === 'webhook_secret_route_mismatch')?.fields).toMatchObject({
      repo: 'your-org/your-repo',
    });
  });

  it('accepts a delivery when the route secret equals the global secret', async () => {
    const env = createEnv({
      ROUTES: JSON.stringify({
        routes: [{ repo: 'your-org/*', webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_ORGA' }],
      }),
      GITHUB_WEBHOOK_SECRET_ORGA: HARNESS_SECRET,
    });
    const { jobs, tier } = recorder_tier();
    const init = await signedInit(PUSH, { 'x-hub-signature-256': await sign(PUSH, HARNESS_SECRET) });
    const res = await handlerWith(tier)(request('/webhook', init), env);
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(1);
  });
});

describe('every post-verification line carries delivery (14.1, 14.3)', () => {
  const DELIVERY = '6f1a2b3c-4d5e-6f70-8901-234567890abc';

  async function linesFor(
    bytes: Uint8Array<ArrayBuffer>,
    over: Record<string, string> = {},
    tier?: AsyncTier,
    env = createEnv(),
  ): Promise<Line[]> {
    const { log, lines } = recorder();
    const { tier: sink } = recorder_tier();
    const init = await signedInit(bytes, { 'x-github-delivery': DELIVERY, ...over });
    await handlerWith(tier ?? sink, { log })(request('/webhook', init), env);
    return lines;
  }

  function assertCarries(lines: Line[], event: string): void {
    const line = lines.find((l) => l.event === event);
    expect(line, `${event} was not logged`).toBeDefined();
    expect(line?.fields?.['deliveryId']).toBe(DELIVERY);
  }

  it('names the delivery on the header, ping and non-push gates', async () => {
    const headers = new Headers(await signedInit(PUSH).then((init) => init.headers));
    headers.delete('x-github-event');
    headers.set('x-github-delivery', DELIVERY);
    const { log, lines } = recorder();
    const { tier } = recorder_tier();
    await handlerWith(tier, { log })(
      request('/webhook', { method: 'POST', headers, body: PUSH }),
      createEnv(),
    );
    assertCarries(lines, 'webhook_event_header_missing');

    assertCarries(await linesFor(PUSH, { 'x-github-event': 'ping' }), 'webhook_ping');
    assertCarries(await linesFor(PUSH, { 'x-github-event': 'issues' }), 'event_ignored');
  });

  it('names the delivery on the parse and shape gates', async () => {
    assertCarries(await linesFor(encoder.encode('{not json')), 'payload_unparseable');
    assertCarries(await linesFor(encoder.encode('{"zen":"hi"}')), 'payload_unrecognized');
  });

  it('names the delivery on the route mismatch and the queue overflow', async () => {
    const routed = createEnv({
      ROUTES: JSON.stringify({
        routes: [{ repo: 'your-org/*', webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_ORGB' }],
      }),
      GITHUB_WEBHOOK_SECRET_ORGB: 'route-b-secret-000000000000000000000000000000',
    });
    assertCarries(await linesFor(PUSH, {}, undefined, routed), 'webhook_secret_route_mismatch');

    const full: AsyncTier = {
      enqueue() {
        return Promise.reject(new QueueFullError('depth', 0, 0, 10));
      },
    };
    assertCarries(await linesFor(PUSH, {}, full), 'queue_overflow');
  });

  it('names the delivery on the accepted path', async () => {
    assertCarries(await linesFor(PUSH), 'push_enqueued');
  });
});

describe('pull request events', () => {
  it('accepts a signed pull_request delivery and enqueues one opened job on the base branch', async () => {
    const { jobs, tier } = recorder_tier();
    const bytes = fixture(prOpened);
    const init = await signedInit(bytes, { 'x-github-event': 'pull_request' });
    const res = await handlerWith(tier)(request('/webhook', init), createEnv());
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'pull_request',
      kind: 'opened',
      refName: 'main',
      refKind: 'branch',
    });
  });

  it('enqueues a review_approved job and rejects pr.opened as pull_request_review', async () => {
    const { jobs, tier } = recorder_tier();
    const reviewBytes = fixture(reviewApproved);
    const reviewInit = await signedInit(reviewBytes, { 'x-github-event': 'pull_request_review' });
    const reviewRes = await handlerWith(tier)(request('/webhook', reviewInit), createEnv());
    expect(reviewRes.status).toBe(202);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'pull_request', kind: 'review_approved', reviewId: 900001 });

    const openedInit = await signedInit(fixture(prOpened), { 'x-github-event': 'pull_request_review' });
    const openedRes = await handler()(request('/webhook', openedInit), createEnv());
    expect(openedRes.status).toBe(422);
  });

  it('202-skips a pull request whose base branch fails BRANCHES and logs pull_request_skipped', async () => {
    const { lines, log } = recorder();
    const { jobs, tier } = recorder_tier();
    const init = await signedInit(fixture(prOpened), { 'x-github-event': 'pull_request' });
    const res = await handlerWith(tier, { log })(
      request('/webhook', init),
      createEnv({ BRANCHES: 'release/*' }),
    );
    expect(res.status).toBe(202);
    expect(jobs).toHaveLength(0);
    expect(lines.find((l) => l.event === 'pull_request_skipped')?.fields).toMatchObject({
      reason: 'pr_base_not_allowed',
      baseRef: 'main',
      patternsTried: ['release/*'],
    });
    expect(lines.find((l) => l.event === 'pull_request_skipped')?.fields?.['deliveryId']).toBeDefined();
  });

  it('401s a route-bound pull request signed with the global secret', async () => {
    const ROUTE_SECRET = 'route-a-secret-000000000000000000000000000000';
    const env = createEnv({
      ROUTES: JSON.stringify({
        routes: [{ repo: 'your-org/*', webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_ORGA' }],
      }),
      GITHUB_WEBHOOK_SECRET_ORGA: ROUTE_SECRET,
      BRANCHES: 'main',
    });
    const { lines, log } = recorder();
    const { jobs, tier } = recorder_tier();
    const init = await signedInit(fixture(prOpened), {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': await sign(fixture(prOpened), HARNESS_SECRET),
    });
    const res = await handlerWith(tier, { log })(request('/webhook', init), env);
    expect(res.status).toBe(401);
    expect(jobs).toHaveLength(0);
    expect(lines.some((l) => l.event === 'pull_request_skipped')).toBe(false);
    expect(lines.some((l) => l.event === 'webhook_secret_route_mismatch')).toBe(true);
  });

  it('422s a malformed pull request body missing pull_request', async () => {
    const body = encoder.encode(JSON.stringify({ action: 'opened', repository: JSON.parse(prOpened).repository }));
    const init = await signedInit(body, { 'x-github-event': 'pull_request' });
    const res = await handler()(request('/webhook', init), createEnv());
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('');
  });

  it('503s with Retry-After when the tier is full and logs queue_overflow on the base branch', async () => {
    const { lines, log } = recorder();
    const full: AsyncTier = {
      enqueue() {
        return Promise.reject(new QueueFullError('depth', 0, 0, 10));
      },
    };
    const init = await signedInit(fixture(prOpened), { 'x-github-event': 'pull_request' });
    const res = await handlerWith(full, { log })(request('/webhook', init), createEnv());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('10');
    expect(lines.find((l) => l.event === 'queue_overflow')?.fields).toMatchObject({
      dropped: 1,
      ref: 'main',
    });
  });

  it('logs pull_request_enqueued on the accepted path', async () => {
    const { lines, log } = recorder();
    const { tier } = recorder_tier();
    const init = await signedInit(fixture(prOpened), { 'x-github-event': 'pull_request' });
    await handlerWith(tier, { log })(request('/webhook', init), createEnv());
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        event: 'pull_request_enqueued',
        fields: expect.objectContaining({
          repo: 'your-org/your-repo',
          pr: 42,
          prKind: 'opened',
        }),
      }),
    );
  });

  it('accepts a delivery with no x-github-delivery header', async () => {
    const { jobs, tier } = recorder_tier();
    const init = await signedInit(fixture(prOpened), { 'x-github-event': 'pull_request' });
    const headers = new Headers(init.headers);
    headers.delete('x-github-delivery');
    const res = await handlerWith(tier)(
      request('/webhook', { ...init, headers }),
      createEnv(),
    );
    expect(res.status).toBe(202);
    expect(jobs[0]?.deliveryId).toBe('');
  });
});

describe('pathnameOf', () => {
  it('returns null for an unparseable URL host', () => {
    expect(pathnameOf('http://1.2.3.999/webhook')).toBeNull();
  });
});
