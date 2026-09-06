import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_SECRET, loadFixture, sign } from './harness.ts';

/** [N] Node-only by file name: this is the one suite the Workers pool cannot
 *  run, since it drives a real child process (15.1). */

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));

interface MockBasecamp {
  port: number;
  posted: string[];
  /** Resolves the first time a request arrives, before it is answered. */
  received: Promise<void>;
  close(): Promise<void>;
}

/** `delayMs: null` never answers, which is the drain-overrun case. */
async function startBasecamp(delayMs: number | null): Promise<MockBasecamp> {
  const posted: string[] = [];
  const sockets = new Set<{ destroy(): void }>();
  let announce: () => void = () => {};
  const received = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(raw) as { content?: unknown };
      posted.push(typeof parsed.content === 'string' ? parsed.content : '');
      announce();
      if (delayMs === null) return;
      setTimeout(() => {
        res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ id: posted.length, status: 'active' }));
      }, delayMs);
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    posted,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

interface Relay {
  port: number;
  lines: Array<Record<string, unknown>>;
  /** Boot refusals are written here, and are the whole failure output (7.2). */
  stderr: string[];
  child: ChildProcessWithoutNullStreams;
  exited: Promise<number | null>;
  kill(): void;
}

async function startRelay(basecampPort: number, over: Record<string, string>): Promise<Relay> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(
    process.execPath,
    [SERVER],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        PORT: String(port),
        GITHUB_WEBHOOK_SECRET: HARNESS_SECRET,
        BASECAMP_ACCOUNT_ID: '1234567',
        BASECAMP_CHATBOT_KEY: 'test-chatbot-key',
        BASECAMP_BUCKET_ID: '2345678',
        BASECAMP_CHAT_ID: '7654321',
        BASECAMP_API_BASE: `http://127.0.0.1:${basecampPort}`,
        // The lifecycle is the subject; a GitHub call would be a second network
        // dependency and the suite is offline (15).
        FETCH_LINE_STATS: 'off',
        LOG_LEVEL: 'info',
        ...over,
      },
      stdio: 'pipe',
    },
  );

  const lines: Array<Record<string, unknown>> = [];
  const stderr: string[] = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim() === '') continue;
      lines.push(JSON.parse(part) as Record<string, unknown>);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => void stderr.push(chunk));

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  return { port, lines, stderr, child, exited, kill: () => void child.kill('SIGKILL') };
}

/** Never 200 outside `ready`: a refused connection and a 503 are both honest
 *  answers, and which one arrives depends on whether the listener is up (14.4). */
async function healthz(port: number): Promise<number | 'refused'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    return res.status;
  } catch {
    return 'refused';
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** A boot refusal is a fixed, numbered list on stderr, so a failure here names
 *  the variable rather than timing out on a silent child (7.2). */
async function waitUntilReady(relay: Relay): Promise<void> {
  try {
    await waitFor(async () => (await healthz(relay.port)) === 200, 15_000);
  } catch (error) {
    throw new Error(`relay never became ready: ${relay.stderr.join('')}`, { cause: error });
  }
}

async function deliver(port: number): Promise<number> {
  const body = loadFixture('push.normal.json');
  const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': crypto.randomUUID(),
      'x-hub-signature-256': await sign(body, HARNESS_SECRET),
    },
    body,
  });
  return res.status;
}

let running: Relay | null = null;
let basecamp: MockBasecamp | null = null;

afterEach(async () => {
  running?.kill();
  running = null;
  await basecamp?.close();
  basecamp = null;
});

describe('the Node lifecycle', () => {
  it(
    'boots to 200, completes the in-flight post on SIGTERM, and exits 0 inside the window',
    async () => {
      basecamp = await startBasecamp(200);
      running = await startRelay(basecamp.port, {
        SHUTDOWN_DRAIN_MS: '6000',
        BASECAMP_TIMEOUT_MS: '2000',
      });
      const relay = running;
      const mock = basecamp;

      // Before ready the listener is not up yet, so the only honest answers are
      // a refused connection or a 503; never a green 200.
      expect(await healthz(relay.port)).not.toBe(200);

      await waitUntilReady(relay);
      expect(await healthz(relay.port)).toBe(200);

      expect(await deliver(relay.port)).toBe(202);
      await mock.received;

      relay.child.kill('SIGTERM');
      const code = await relay.exited;

      expect(code).toBe(0);
      expect(mock.posted).toHaveLength(3);
      const events = relay.lines.map((line) => line['evt']);
      expect(events).toContain('server_draining');
      expect(events).toContain('drain_complete');
      expect(events).not.toContain('drain_incomplete');
      expect(await healthz(relay.port)).not.toBe(200);
    },
    30_000,
  );

  it(
    'logs drain_incomplete and still exits 0 when the drain overruns',
    async () => {
      // The mock never answers, so the queue is still holding jobs when
      // SHUTDOWN_DRAIN_MS expires (16.2.3 step 4).
      basecamp = await startBasecamp(null);
      running = await startRelay(basecamp.port, {
        // The floor for both: the drain deadline may not sit under the post
        // timeout, or a drain would always kill an in-flight post (7.2).
        SHUTDOWN_DRAIN_MS: '1000',
        BASECAMP_TIMEOUT_MS: '1000',
      });
      const relay = running;
      const mock = basecamp;

      await waitUntilReady(relay);
      expect(await deliver(relay.port)).toBe(202);
      await mock.received;

      relay.child.kill('SIGTERM');
      const code = await relay.exited;

      expect(code).toBe(0);
      const events = relay.lines.map((line) => line['evt']);
      expect(events).toContain('drain_incomplete');
      expect(events).toContain('jobs_lost');
      expect(events).not.toContain('drain_complete');
    },
    30_000,
  );
  it(
    'logs each boot warning exactly once, from the loader alone',
    async () => {
      basecamp = await startBasecamp(200);
      running = await startRelay(basecamp.port, {
        ROUTES: JSON.stringify({
          routes: [{ repo: '**', target: { chatbotKey: 'inline-key-aaaaaaaa' } }],
        }),
      });
      const relay = running;
      const mock = basecamp;

      await waitUntilReady(relay);
      // The webhook builds the routing memo, which is the second place these
      // two warnings used to be emitted from.
      expect(await deliver(relay.port)).toBe(202);
      await mock.received;

      relay.child.kill('SIGTERM');
      await relay.exited;

      const events = relay.lines.map((line) => line['evt']);
      expect(events.filter((evt) => evt === 'repo_allowlist_open')).toHaveLength(1);
      expect(events.filter((evt) => evt === 'chatbotkey_inline_in_config')).toHaveLength(1);
      expect(events.filter((evt) => evt === 'config_loaded')).toHaveLength(1);
    },
    30_000,
  );

  it(
    'refuses to boot on an invalid config with both the numbered stderr list and a fatal line',
    async () => {
      basecamp = await startBasecamp(201);
      running = await startRelay(basecamp.port, {
        GITHUB_WEBHOOK_SECRET: '',
        BASECAMP_CHAT_ID: '',
      });
      const relay = running;

      const code = await relay.exited;

      expect(code).toBe(1);
      const printed = relay.stderr.join('');
      expect(printed).toContain('1.');
      expect(printed).toContain('GITHUB_WEBHOOK_SECRET');
      expect(printed).toContain('BASECAMP_CHAT_ID');

      // Row 32: the refusal is also one NDJSON fatal line (14.2).
      const fatal = relay.lines.find((line) => line['evt'] === 'config_invalid');
      expect(fatal).toBeDefined();
      expect(fatal?.['lvl']).toBe('fatal');
      expect(fatal?.['tgt']).toBe('node');
      expect(fatal?.['problems']).toBe(2);
      expect(fatal?.['missing']).toEqual(['GITHUB_WEBHOOK_SECRET', 'BASECAMP_CHAT_ID']);
    },
    30_000,
  );

  it(
    'accepts a signed delivery when idle sockets declare large Content-Length but send no body',
    async () => {
      basecamp = await startBasecamp(200);
      running = await startRelay(basecamp.port, {});
      const relay = running;
      await waitUntilReady(relay);

      const maxBody = 26_214_400;
      const idle: Socket[] = [];
      try {
        for (let i = 0; i < 3; i++) {
          const socket = connect(relay.port, '127.0.0.1');
          await new Promise<void>((resolve, reject) => {
            socket.once('connect', () => resolve());
            socket.once('error', reject);
          });
          socket.write(
            `POST /webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${maxBody}\r\n\r\n`,
          );
          idle.push(socket);
        }
        expect(await deliver(relay.port)).toBe(202);
      } finally {
        for (const socket of idle) socket.destroy();
      }
    },
    30_000,
  );
});

describe('a Node boot refusal', () => {
  it.each([
    ['a missing webhook secret', ''],
    ['a webhook secret under 32 characters', 'short-key-'],
  ])('exits 1 and names the key on stderr for %s', async (_label, secret) => {
    // Boot fails before anything is dialled, so the port never has to answer.
    running = await startRelay(1, { GITHUB_WEBHOOK_SECRET: secret });
    const relay = running;

    const code = await relay.exited;
    expect(code).toBe(1);

    const printed = relay.stderr.join('');
    expect(printed).toContain('commit-relay: configuration is invalid.');
    expect(printed).toContain('  1. GITHUB_WEBHOOK_SECRET');
    expect(printed).toContain('1 problem.');
    expect(printed).not.toContain('short-key-');
  }, 30_000);
});
