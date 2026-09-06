import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker.ts';
import type { QueuedJob } from '../src/core/types.ts';
import { toQueuedJob } from '../src/core/types.ts';
import { createEnv } from './harness.ts';
import { job as makeJob, pullRequestJob, queuedJob } from './push-job.ts';

/** [N] `src/worker.ts` binds `globalThis.fetch` by design, so a real 429 needs a
 *  real loopback listener via `PushJob.target.apiBase`: hence node-only. */

interface Basecamp {
  port: number;
  requests: number;
  close(): Promise<void>;
}

async function startBasecamp(retryAfter: string, status = 429): Promise<Basecamp> {
  const sockets = new Set<{ destroy(): void }>();
  const state = { requests: 0 };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {});
    req.on('end', () => {
      state.requests += 1;
      const headers: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
      };
      if (status === 429) headers['retry-after'] = retryAfter;
      res.writeHead(status, headers);
      res.end('{}');
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

interface FakeMessage {
  acks: number;
  retries: Array<{ delaySeconds?: number }>;
}

interface SentMessage {
  job: QueuedJob;
  options?: { delaySeconds?: number };
}

function batch(body: unknown, attempts: number): { batch: unknown; message: FakeMessage } {
  const message: FakeMessage = { acks: 0, retries: [] };
  return {
    message,
    batch: {
      queue: 'commits',
      messages: [
        {
          id: 'message-1',
          timestamp: new Date(0),
          body,
          attempts,
          ack: () => void (message.acks += 1),
          retry: (options?: { delaySeconds?: number }) => void message.retries.push(options ?? {}),
        },
      ],
    },
  };
}

const prQueued = (): QueuedJob => toQueuedJob(pullRequestJob());

/** One rollup line and no per-commit stats, so the only outbound call in the
 *  whole test is the Basecamp post the mock answers 429. */
const rollupQueued = (): QueuedJob =>
  toQueuedJob(
    makeJob({
      commits: [],
      rollup: { kind: 'cap', fileCount: 31, authors: ['jane-doe', 'sam-lee'] },
    }),
  );

// The wait is handed straight back to the queue rather than slept off inside the
// invocation, which is what makes the 429 a retry instead of a held isolate.
const ENV = createEnv({ RATELIMIT_WAIT_BUDGET_MS: '0' });

type QueueBatch = Parameters<typeof worker.queue>[0];
type QueueEnv = Parameters<typeof worker.queue>[1];

let basecamp: Basecamp | null = null;

afterEach(async () => {
  await basecamp?.close();
  basecamp = null;
  vi.restoreAllMocks();
});

describe('the queue handler on a Basecamp 429', () => {
  it('processes a pull request batch message, posts one line, and acks it', async () => {
    basecamp = await startBasecamp('', 201);
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
      lines.push(JSON.parse(String(text)) as Record<string, unknown>);
    });
    const env = {
      ...createEnv({
        BASECAMP_MIN_INTERVAL_MS: '0',
        FETCH_LINE_STATS: 'off',
        POST_RETRY_BUDGET_MS: '0',
      }),
      BASECAMP_API_BASE: `http://127.0.0.1:${String(basecamp.port)}`,
    };
    const { batch: b, message } = batch(prQueued(), 1);

    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    expect(basecamp.requests).toBe(1);
    expect(message.acks).toBe(1);
    expect(message.retries).toHaveLength(0);
    expect(lines.some((line) => line['evt'] === 'message_posted')).toBe(true);
  });

  it('re-enqueues with the parsed Retry-After and acks the original', async () => {
    basecamp = await startBasecamp('7');
    const sent: SentMessage[] = [];
    const env = {
      ...ENV,
      BASECAMP_API_BASE: `http://127.0.0.1:${String(basecamp.port)}`,
      COMMITS: {
        send: (job: QueuedJob, options?: { delaySeconds?: number }) => void sent.push({ job, options }),
      },
    };
    const { batch: b, message } = batch(rollupQueued(), 1);

    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    expect(basecamp.requests).toBe(1);
    expect(message.retries).toHaveLength(0);
    expect(message.acks).toBe(1);
    expect(sent).toEqual([
      { job: expect.objectContaining({ deferrals: 1, resumeAtSeq: 0 }), options: { delaySeconds: 7 } },
    ]);
    const serialized = JSON.stringify(sent[0]?.job);
    expect(serialized).not.toContain('test-chatbot-key');
    expect(serialized).not.toContain('githubToken');
  });

  it('logs queue_redelivery with the attempt on a redelivered message', async () => {
    basecamp = await startBasecamp('3');
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
      lines.push(JSON.parse(String(text)) as Record<string, unknown>);
    });
    const sent: SentMessage[] = [];
    const env = {
      ...ENV,
      BASECAMP_API_BASE: `http://127.0.0.1:${String(basecamp.port)}`,
      COMMITS: {
        send: (job: QueuedJob, options?: { delaySeconds?: number }) => void sent.push({ job, options }),
      },
    };

    const { batch: b, message } = batch(rollupQueued(), 3);
    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    const redelivery = lines.find((line) => line['evt'] === 'queue_redelivery');
    expect(redelivery).toMatchObject({ lvl: 'info', attempt: 3, repo: 'your-org/your-repo' });
    expect(message.retries).toHaveLength(0);
    expect(message.acks).toBe(1);
    expect(sent[0]?.options).toEqual({ delaySeconds: 3 });
  });

  it('re-enqueues a pull request whole on a 429 beyond budget', async () => {
    basecamp = await startBasecamp('7');
    const sent: SentMessage[] = [];
    const env = {
      ...ENV,
      BASECAMP_API_BASE: `http://127.0.0.1:${String(basecamp.port)}`,
      COMMITS: {
        send: (job: QueuedJob, options?: { delaySeconds?: number }) => void sent.push({ job, options }),
      },
    };
    const { batch: b, message } = batch(prQueued(), 1);

    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    expect(basecamp.requests).toBe(1);
    expect(message.acks).toBe(1);
    expect(sent).toEqual([
      { job: expect.objectContaining({ deferrals: 1, type: 'pull_request' }), options: { delaySeconds: 7 } },
    ]);
    expect(sent[0]?.job).not.toHaveProperty('resumeAtSeq');
  });

  it('acks an invalid message body and logs queue_message_invalid', async () => {
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
      lines.push(JSON.parse(String(text)) as Record<string, unknown>);
    });
    const env = { ...ENV, COMMITS: { send: () => {} } };
    const { batch: b, message } = batch({ garbage: true }, 1);

    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    expect(message.acks).toBe(1);
    expect(lines.find((line) => line['evt'] === 'queue_message_invalid')).toMatchObject({
      lvl: 'error',
      attempt: 1,
    });
  });

  it('acks when the route no longer matches and logs route_vanished', async () => {
    basecamp = await startBasecamp('3');
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
      lines.push(JSON.parse(String(text)) as Record<string, unknown>);
    });
    const env = {
      ...createEnv({
        RATELIMIT_WAIT_BUDGET_MS: '0',
        ROUTES: JSON.stringify({
          routes: [{ repo: 'other-org/*', target: { chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY' } }],
        }),
      }),
      COMMITS: { send: () => {} },
    };
    const { batch: b, message } = batch(queuedJob(), 1);

    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    expect(basecamp.requests).toBe(0);
    expect(message.acks).toBe(1);
    expect(lines.find((line) => line['evt'] === 'route_vanished')).toMatchObject({
      lvl: 'warn',
      repo: 'your-org/your-repo',
      delivery: 'delivery-1',
    });
  });

  it('acks a pull request whose base branch no longer matches and logs route_vanished', async () => {
    basecamp = await startBasecamp('3');
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
      lines.push(JSON.parse(String(text)) as Record<string, unknown>);
    });
    const env = {
      ...createEnv({
        RATELIMIT_WAIT_BUDGET_MS: '0',
        BRANCHES: 'release/*',
      }),
      COMMITS: { send: () => {} },
    };
    const { batch: b, message } = batch(toQueuedJob(pullRequestJob({ refName: 'main' })), 1);

    await worker.queue(b as QueueBatch, env as unknown as QueueEnv);

    expect(basecamp.requests).toBe(0);
    expect(message.acks).toBe(1);
    expect(lines.find((line) => line['evt'] === 'route_vanished')).toMatchObject({
      lvl: 'warn',
      ref: 'main',
    });
  });
});
