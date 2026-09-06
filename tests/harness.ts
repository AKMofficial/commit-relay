import { app, setAppContext } from '../src/http/app.ts';
import { tryGetConfig } from '../src/config/load.ts';
import { createSubrequestBudget } from '../src/core/subrequests.ts';
import type { Deps } from '../src/runtime/deps.ts';
import type { Config } from '../src/config/schema.ts';
import type { LogFn, LogLevel } from '../src/obs/log.ts';
import type { RelayJob } from '../src/core/types.ts';
import { consumeJob } from '../src/queue/consumer.ts';
import type { Dedup } from '../src/relay/dedup.ts';
import { createMemoryDedup } from '../src/queue/adapters/store-memory.ts';
import { createFakeMetrics, type FakeMetrics } from './fake-metrics.ts';
import { createGitHubMock, type GitHubMock, type GitHubMockOptions } from './mock-github.ts';
import pushNormal from './fixtures/push.normal.json?raw';
import pushAstral from './fixtures/push.astral.json?raw';
import pushBot from './fixtures/push.bot.json?raw';
import pushBranchCreate from './fixtures/push.branch-create.json?raw';
import pushBranchDelete from './fixtures/push.branch-delete.json?raw';
import pushEmpty from './fixtures/push.empty.json?raw';
import pushForced from './fixtures/push.forced.json?raw';
import pushInjection from './fixtures/push.injection.json?raw';
import pushLarge from './fixtures/push.large.json?raw';
import pushMerge from './fixtures/push.merge.json?raw';
import pushNonDistinct from './fixtures/push.non-distinct.json?raw';
import pushTag from './fixtures/push.tag.json?raw';
import pushTagWithCommits from './fixtures/push.tag-with-commits.json?raw';
import pushUnknownFields from './fixtures/push.unknown-fields.json?raw';
import prOpened from './fixtures/pr.opened.json?raw';
import prMerged from './fixtures/pr.merged.json?raw';
import prClosed from './fixtures/pr.closed.json?raw';
import prReopened from './fixtures/pr.reopened.json?raw';
import prDraft from './fixtures/pr.draft.json?raw';
import prReadyForReview from './fixtures/pr.ready-for-review.json?raw';
import prInjection from './fixtures/pr.injection.json?raw';
import reviewApproved from './fixtures/review.approved.json?raw';
import reviewChangesRequested from './fixtures/review.changes-requested.json?raw';
import commitStats from './fixtures/commit.stats.json?raw';
import commitStatsMerge from './fixtures/commit.stats.merge.json?raw';
import hmacVectors from './fixtures/hmac-vectors.json?raw';

type Ctx = NonNullable<Parameters<typeof app.request>[3]>;

export function createEnv(over: Record<string, unknown> = {}) {
  return {
    // Over the 32-char boot minimum on purpose. GitHub's own vector secret is
    // 26 chars and is used ONLY in src/security/hmac.test.ts, which calls
    // verifySignature() directly and never boots the app. See 15.2.
    GITHUB_WEBHOOK_SECRET: 'test-webhook-secret-0000000000000000000000000000',
    BASECAMP_ACCOUNT_ID: '1234567',
    BASECAMP_CHATBOT_KEY: 'test-chatbot-key',
    BASECAMP_BUCKET_ID: '2345678',
    BASECAMP_CHAT_ID: '7654321',
    MAX_COMMITS_PER_PUSH: '15',
    ...over,
  };
}

export function createCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    // Verbatim from the spec; the cast is only because hono's current
    // ExecutionContext type carries an extra `props` field this shape omits.
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as Ctx,
    settled: () => Promise.allSettled(pending),
  };
}

export async function post(body: Uint8Array<ArrayBuffer>, sig: string, env = createEnv()) {
  const { ctx, settled } = createCtx();
  const res = await app.request(
    '/webhook',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': sig,
      },
      body,
    },
    env,
    ctx,
  );
  await settled();
  return res;
}

export const HARNESS_SECRET = createEnv().GITHUB_WEBHOOK_SECRET;

const encoder = new TextEncoder();

/** Fixtures are bytes, never a parsed-then-restringified object (15.5). The
 *  `?raw` import is what makes the identical loader work under the Workers
 *  pool, which has no filesystem. */
export const FIXTURES: Record<string, string> = {
  'push.normal.json': pushNormal,
  'push.astral.json': pushAstral,
  'push.bot.json': pushBot,
  'push.branch-create.json': pushBranchCreate,
  'push.branch-delete.json': pushBranchDelete,
  'push.empty.json': pushEmpty,
  'push.forced.json': pushForced,
  'push.injection.json': pushInjection,
  'push.large.json': pushLarge,
  'push.merge.json': pushMerge,
  'push.non-distinct.json': pushNonDistinct,
  'push.tag.json': pushTag,
  'push.tag-with-commits.json': pushTagWithCommits,
  'push.unknown-fields.json': pushUnknownFields,
  'pr.opened.json': prOpened,
  'pr.merged.json': prMerged,
  'pr.closed.json': prClosed,
  'pr.reopened.json': prReopened,
  'pr.draft.json': prDraft,
  'pr.ready-for-review.json': prReadyForReview,
  'pr.injection.json': prInjection,
  'review.approved.json': reviewApproved,
  'review.changes-requested.json': reviewChangesRequested,
  'commit.stats.json': commitStats,
  'commit.stats.merge.json': commitStatsMerge,
  'hmac-vectors.json': hmacVectors,
};

export function loadFixture(name: string): Uint8Array<ArrayBuffer> {
  const text = FIXTURES[name];
  if (text === undefined) throw new Error(`unknown fixture: ${name}`);
  return encoder.encode(text);
}

export async function sign(bodyBytes: Uint8Array<ArrayBuffer>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
  );
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

export interface LogLine {
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
}

export interface LogRecorder {
  log: LogFn;
  lines: LogLine[];
  events(): string[];
  find(event: string): LogLine | undefined;
  all(event: string): LogLine[];
}

export function createLogRecorder(): LogRecorder {
  const lines: LogLine[] = [];
  return {
    log: (level, event, fields) => void lines.push({ level, event, fields: fields ?? {} }),
    lines,
    events: () => lines.map((line) => line.event),
    find: (event) => lines.find((line) => line.event === event),
    all: (event) => lines.filter((line) => line.event === event),
  };
}

export interface Sleeper {
  sleep: (ms: number) => Promise<void>;
  ms: number[];
}

/** Scaled, never faked: zeroing sleeps would reorder the interval-expressed
 *  guarantees, and `workerd` freezes the clock outside I/O (4.1). */
export function createSleeper(): Sleeper {
  const ms: number[] = [];
  return {
    ms,
    sleep(requested: number) {
      ms.push(requested);
      const scaled = Math.min(50, Math.round(requested / 1000));
      return new Promise<void>((resolve) => setTimeout(resolve, scaled));
    },
  };
}

export interface BasecampCall {
  url: string;
  content: string;
}

export interface BasecampReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Per-call scripted response; the default is Basecamp's documented 201. */
export type BasecampScript = (call: { index: number; content: string }) => BasecampReply;

export interface BasecampRecorder {
  readonly calls: BasecampCall[];
  contents(): string[];
  /** Two overlapping posts is the failure the serial poster exists to prevent. */
  maxInFlight: number;
  matches(url: string): boolean;
  handle(url: string, init: RequestInit | undefined): Promise<Response>;
}

const LINES_PATH = /^\/\d+\/integrations\/[^/]+\/buckets\/\d+\/chats\/\d+\/lines\.json$/;

function postedContent(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string') return '';
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) return '';
  const content = (parsed as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

export function createBasecampRecorder(script?: BasecampScript): BasecampRecorder {
  const calls: BasecampCall[] = [];
  let inFlight = 0;

  const recorder: BasecampRecorder = {
    calls,
    contents: () => calls.map((call) => call.content),
    maxInFlight: 0,

    matches(url: string): boolean {
      return LINES_PATH.test(new URL(url).pathname);
    },

    async handle(url: string, init: RequestInit | undefined): Promise<Response> {
      const content = postedContent(init);
      const index = calls.length;
      calls.push({ url, content });

      inFlight += 1;
      recorder.maxInFlight = Math.max(recorder.maxInFlight, inFlight);
      // A macrotask, so a second caller that is already running would be
      // recorded as in flight rather than silently serialised by the mock.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;

      const reply = script?.({ index, content }) ?? { status: 201 };
      return new Response(reply.body ?? JSON.stringify({ id: index + 1, status: 'active' }), {
        status: reply.status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers },
      });
    },
  };

  return recorder;
}

export interface Router {
  fetchImpl: typeof fetch;
  github: GitHubMock;
  basecamp: BasecampRecorder;
}

/** The injected `fetch`: every outbound call in the suite goes through here, and
 *  an unrouted URL is an error rather than a silent escape to the network (15). */
export function createFetchRouter(github: GitHubMock, basecamp: BasecampRecorder): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (basecamp.matches(url)) return basecamp.handle(url, init);
    if (github.matches(url)) return github.handle(url);
    return Promise.reject(new Error(`unrouted fetch: ${url}`));
  }) as typeof fetch;
}

export interface DepsOptions {
  config: Config;
  fetchImpl: typeof fetch;
  log?: LogFn;
  sleep?: (ms: number) => Promise<void>;
  metrics?: FakeMetrics;
  now?: () => number;
  /** 0 = unlimited, which is the node-target default and what most tests want. */
  subrequestBudget?: number;
}

export function createDeps(options: DepsOptions): Deps {
  return {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep ?? createSleeper().sleep,
    log: options.log ?? (() => {}),
    metrics: options.metrics ?? createFakeMetrics(),
    now: options.now ?? Date.now,
    config: options.config,
    subrequests: createSubrequestBudget(options.subrequestBudget ?? 0),
  };
}

export function configOf(env: Record<string, unknown>): Config {
  const loaded = tryGetConfig(env as Record<string, string | undefined>);
  if (!loaded.ok) throw new Error(`test env does not boot: ${loaded.missing.join(', ')}`);
  return loaded.config;
}

export interface Delivery {
  res: Response;
  /** Resolves once every promise the handler handed to `ctx.waitUntil` has. */
  settle: () => Promise<void>;
}

export interface RelayOptions {
  env?: Record<string, unknown>;
  github?: GitHubMockOptions;
  basecamp?: BasecampScript;
}

export interface Relay {
  env: Record<string, unknown>;
  config: Config;
  deps: Deps;
  github: GitHubMock;
  basecamp: BasecampRecorder;
  metrics: FakeMetrics;
  dedup: Dedup;
  logs: LogRecorder;
  sleeps: number[];
  /** One entry per push accepted by gate 10, never one per commit. */
  enqueued: RelayJob[];
  deliver(body: Uint8Array<ArrayBuffer>, headers?: Record<string, string>): Promise<Delivery>;
  relay(body: Uint8Array<ArrayBuffer>, headers?: Record<string, string>): Promise<Response>;
  restore(): void;
}

/** The whole product wired to the two mocks. The tier mirrors `WaitUntilTier`,
 *  so the 202 is written before any outbound call is made (9.3 gate 10). */
export function createRelay(options: RelayOptions = {}): Relay {
  const env = createEnv(options.env);
  const config = configOf(env);
  const github = createGitHubMock(options.github);
  const basecamp = createBasecampRecorder(options.basecamp);
  const logs = createLogRecorder();
  const sleeper = createSleeper();
  const metrics = createFakeMetrics();
  const deps = createDeps({
    config,
    fetchImpl: createFetchRouter(github, basecamp),
    log: logs.log,
    sleep: sleeper.sleep,
    metrics,
  });
  const dedup = createMemoryDedup(config, metrics, Date.now);
  const enqueued: RelayJob[] = [];

  setAppContext({
    tier: (_env, ctx) => ({
      enqueue(job: RelayJob) {
        enqueued.push(job);
        // The pump starts on the next scheduler turn, never inside `enqueue`,
        // exactly as MemoryFifoTier does, so the 202 is written before any
        // outbound call is made (9.3 gate 10).
        const started = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
          consumeJob(job, deps, { dedup }),
        );
        (ctx as { waitUntil(promise: Promise<unknown>): void }).waitUntil(started);
        return Promise.resolve();
      },
    }),
  });

  async function deliver(
    body: Uint8Array<ArrayBuffer>,
    headers: Record<string, string> = {},
  ): Promise<Delivery> {
    const { ctx, settled } = createCtx();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': crypto.randomUUID(),
          'x-hub-signature-256': await sign(body, String(env['GITHUB_WEBHOOK_SECRET'])),
          ...headers,
        },
        body,
      },
      env,
      ctx,
    );
    return { res, settle: async () => void (await settled()) };
  }

  return {
    env,
    config,
    deps,
    github,
    basecamp,
    metrics,
    dedup,
    logs,
    sleeps: sleeper.ms,
    enqueued,
    deliver,
    async relay(body, headers) {
      const delivery = await deliver(body, headers);
      await delivery.settle();
      return delivery.res;
    },
    restore() {
      setAppContext({ tier: () => ({ enqueue: () => Promise.resolve() }) });
    },
  };
}
