import { z } from 'zod';
import {
  BOOLEAN_MESSAGE,
  NUMERIC_MESSAGE,
  SECRET_MIN_LENGTH,
  coerceBool,
  coerceInt,
  coerceList,
  isSet,
  readValue,
  type EnvSource,
} from './env.ts';
import { requireLineStatsViolated } from '../github/token.ts';
import { parseLinesUrl } from './lines-url.ts';
import { compileGlob } from './glob.ts';
import pkg from '../../package.json' with { type: 'json' };

/** Names the received type in the worked example's words (7.2). */
function describeInput(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'an array';
  const kind = typeof input;
  return kind === 'object' ? 'an object' : `a ${kind}`;
}

const numericId = z
  .string({ error: (issue) => `expected a numeric string, received ${describeInput(issue.input)}.` })
  .trim()
  .regex(/^\d{1,20}$/, 'must be a numeric id, quoted as a string');

const envName = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an UPPER_SNAKE_CASE environment variable name');

/** Basecamp issues URL-safe token keys, so anything else is a paste error. The key is never echoed. */
const CHATBOT_KEY_CHARSET = /^[A-Za-z0-9_-]+$/;
const CHATBOT_KEY_CHARSET_MESSAGE = 'must contain only letters, digits, "-" and "_".';

/** Shared by the inline fields and the env variables that routes name, so a
 *  route's key or secret meets exactly the policy of the global one. */
const chatbotKeyValue = z
  .string()
  .trim()
  .min(8, 'must be at least 8 characters.')
  .max(200, 'must be at most 200 characters.')
  .regex(CHATBOT_KEY_CHARSET, CHATBOT_KEY_CHARSET_MESSAGE)
  .superRefine(denyPublishedLiterals);

const GLOBSTAR_MAX_MESSAGE = 'must not contain more than 2 "**" segments.';

function maxGlobstars(pattern: string): boolean {
  return pattern.split('/').filter((segment) => segment === '**').length <= 2;
}

const globPattern = z
  .string()
  .min(1)
  .max(200)
  .refine(maxGlobstars, { message: GLOBSTAR_MAX_MESSAGE });

const globList = z.array(globPattern).max(64);

/** The pull request actions this version renders. Matched by equality, never
 *  as globs, so `*` is a boot error rather than a silent switch-off. */
export const PR_ACTIONS = ['opened', 'closed', 'reopened', 'ready_for_review'] as const;
const prActionList = z.array(z.enum(PR_ACTIONS)).max(PR_ACTIONS.length);

const target = z
  .object({
    accountId: numericId.optional(),
    bucketId: numericId.optional(),
    chatId: numericId.optional(),
    chatbotKeyEnv: envName
      .regex(
        /^BASECAMP_CHATBOT_KEY(_[A-Z0-9_]+)?$/,
        'must be BASECAMP_CHATBOT_KEY or BASECAMP_CHATBOT_KEY_<SUFFIX>.',
      )
      .optional(),
    /** Warns at boot: a bearer credential inline in a config file. */
    chatbotKey: chatbotKeyValue.optional(),
  })
  .strict()
  .refine((t) => !(t.chatbotKey && t.chatbotKeyEnv), {
    message: 'set chatbotKey or chatbotKeyEnv, not both',
  });

const route = z
  .object({
    repo: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(maxGlobstars, { message: GLOBSTAR_MAX_MESSAGE }),
    branches: globList.optional(),
    tags: globList.optional(),
    target: target.optional(),
    githubTokenEnv: envName
      .regex(/^GITHUB_TOKEN_[A-Z0-9_]+$/, 'must be named GITHUB_TOKEN_<SUFFIX>')
      .optional(),
    webhookSecretEnv: envName
      .regex(/^GITHUB_WEBHOOK_SECRET_[A-Z0-9_]+$/, 'must be named GITHUB_WEBHOOK_SECRET_<SUFFIX>')
      .optional(),
    githubApiBase: noCredentials(z.string().trim().url().startsWith('https://')).optional(),
    skipMergeCommits: z.boolean().optional(),
    skipForcedPushes: z.boolean().optional(),
    skipNonDistinct: z.boolean().optional(),
    ignoreAuthors: globList.optional(),
    maxCommitsPerPush: z.number().int().min(1).max(100).optional(),
    prActions: prActionList.optional(),
    prReviews: z.boolean().optional(),
    prSkipDrafts: z.boolean().optional(),
  })
  .strict();

export const routesDocument = z
  .object({
    defaults: z
      .object({ branches: globList.optional(), tags: globList.optional(), target: target.optional() })
      .strict()
      .optional(),
    routes: z.array(route).max(200).default([]),
    fallthrough: z.enum(['ignore', 'defaults']).default('ignore'),
  })
  .strict();

export type RoutesDocument = z.infer<typeof routesDocument>;
export type Route = z.infer<typeof route>;
export type Target = z.infer<typeof target>;

/** Refused for every secret-bearing field regardless of NODE_ENV: copying the
 *  development block into production is the most common self-host mistake (11.2). */
const PUBLISHED_LITERAL_SOURCES: Readonly<Record<string, string>> = {
  'dev-secret-do-not-use-in-production': "this repository's documentation",
  'replace-me-with-openssl-rand-hex-32': '.env.example and .dev.vars.example',
  'replace-me-with-your-chatbot-key': 'docs/configuration.md',
  '0f2b8c1d4a6e9f3b7c05d81a2e4f6b9c3d5a7e1f8b0c2d4a6e9f3b7c05d81a2e': 'docs/configuration.md',
  PLACEHOLDERKEY0123456789: '.env.example and .dev.vars.example',
};

const WEBHOOK_SECRET_MAX_LENGTH = 1024;

export const PUBLISHED_SECRET_LITERALS: readonly string[] = Object.keys(PUBLISHED_LITERAL_SOURCES);

function publishedLiteral(value: string): string | null {
  const hit = PUBLISHED_SECRET_LITERALS.find((literal) => literal.toLowerCase() === value.toLowerCase());
  return hit ?? null;
}

/** Names the file the literal is published in, so an operator can go and look at
 *  the line they copied. */
function publishedLiteralMessage(literal: string): string {
  const where = PUBLISHED_LITERAL_SOURCES[literal] ?? 'this repository';
  return `must not be a value published in this repository. "${literal}" appears in ${where} and is public.`;
}

/** Printable ASCII only: no whitespace or control characters (11.2). */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const PRINTABLE_ASCII_MESSAGE = 'must not contain whitespace or control characters.';

function denyPublishedLiterals(value: string, ctx: z.RefinementCtx): void {
  const literal = publishedLiteral(value);
  if (literal === null) return;
  ctx.addIssue({ code: 'custom', message: publishedLiteralMessage(literal) });
}

const webhookSecretValue = z
  .string({ error: (issue) => (issue.input === undefined ? 'is not set.' : 'must be a string.') })
  .trim()
  .min(SECRET_MIN_LENGTH, `must be at least ${SECRET_MIN_LENGTH} characters.`)
  .max(WEBHOOK_SECRET_MAX_LENGTH, `must be at most ${WEBHOOK_SECRET_MAX_LENGTH} characters.`)
  .superRefine(denyPublishedLiterals);

const githubTokenValue = z
  .string()
  .trim()
  .min(1)
  .max(1024, 'must be at most 1024 characters.')
  .regex(PRINTABLE_ASCII, PRINTABLE_ASCII_MESSAGE)
  .superRefine(denyPublishedLiterals);

function intVar(fallback: number, min: number, max: number) {
  return z
    .preprocess(
      coerceInt,
      z
        .number({ error: NUMERIC_MESSAGE })
        .int(NUMERIC_MESSAGE)
        .min(min, `must be at least ${min}.`)
        .max(max, `must be at most ${max}.`),
    )
    .default(fallback);
}

function boolVar(fallback: boolean) {
  return z.preprocess(coerceBool, z.boolean({ error: BOOLEAN_MESSAGE })).default(fallback);
}

function listVar(fallback: string[]) {
  return z.preprocess(coerceList, globList).default(fallback);
}

/** Shared by every API base, global or per-route: a credential in the URL is not
 *  registered with the redactor. */
function noCredentials<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((v) => {
    try {
      const u = new URL(v);
      return u.username === '' && u.password === '';
    } catch {
      return true; // the url() check reports it
    }
  }, 'must not contain credentials.');
}

/** An absolute URL with no scheme constraint: BASECAMP_API_BASE is documented as
 *  taking a plain-http mock (`http://127.0.0.1:9999`), and a GHES API base is
 *  the operator's own host. */
function urlBase(fallback: string) {
  return noCredentials(
    z
      .string()
      .trim()
      .url('must be an absolute URL, e.g. https://api.github.com')
      .refine(
        (v) => {
          if (v.startsWith('https://')) return true;
          try {
            const u = new URL(v);
            return (
              v.startsWith('http://') &&
              (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
            );
          } catch {
            return false;
          }
        },
        'must use the https scheme.',
      ),
  ).default(fallback);
}

/** GITHUB_WEB_ORIGIN is the sole allowlist `safeUrl()` checks rendered hrefs
 *  against, and safeUrl requires the https: scheme (9.4), so an http origin here
 *  would allowlist links the renderer then refuses. */
function httpsOrigin(fallback: string) {
  return z
    .string()
    .trim()
    .url('must be an absolute URL, e.g. https://github.com')
    .startsWith('https://', 'must use https://, because it is the allowlist every rendered link is checked against.')
    .default(fallback);
}

const MAX_MS = 86_400_000;

/** `USER_AGENT` and the docs URL are derived from the manifest so a fork is
 *  correct with zero edits and no `<owner>` placeholder can ship unresolved. */
export const REPOSITORY_URL: string = pkg.repository.url;
const DEFAULT_USER_AGENT = `${pkg.name}/${pkg.version} (+${REPOSITORY_URL})`;
export const DEFAULT_WEBHOOK_PATH = '/webhook';

/** Exported so /health/detail can hold its fallback read to the same rule. */
export const healthTokenValue = z.string().trim().min(16, 'must be at least 16 characters.').max(256);

export const configObject = z.object({
  BASECAMP_LINES_URL: z
    .string()
    .trim()
    .refine((v) => parseLinesUrl(v) !== null, {
      message:
        'must be the whole chatbot posting URL, e.g. https://3.basecampapi.com/1234567/integrations/KEY/buckets/2345678/chats/7654321/lines.json',
    })
    .optional(),
  BASECAMP_ACCOUNT_ID: numericId.optional(),
  BASECAMP_CHATBOT_KEY: chatbotKeyValue.optional(),
  BASECAMP_BUCKET_ID: numericId.optional(),
  BASECAMP_CHAT_ID: numericId.optional(),
  BASECAMP_API_BASE: urlBase('https://3.basecampapi.com'),
  BASECAMP_TIMEOUT_MS: intVar(10_000, 1_000, MAX_MS),
  BASECAMP_MIN_INTERVAL_MS: intVar(250, 0, MAX_MS),
  BASECAMP_MAX_SLEEP_MS: intVar(30_000, 0, MAX_MS),
  USER_AGENT: z.string().trim().min(1).max(256).default(DEFAULT_USER_AGENT),

  GITHUB_WEBHOOK_SECRET: webhookSecretValue,
  GITHUB_TOKEN: githubTokenValue.optional(),
  GITHUB_API_BASE: urlBase('https://api.github.com'),
  GITHUB_WEB_ORIGIN: httpsOrigin('https://github.com'),
  GITHUB_CONCURRENCY: intVar(4, 1, 32),
  GITHUB_TIMEOUT_MS: intVar(8_000, 1_000, MAX_MS),
  GITHUB_STATS_MAX_BYTES: intVar(1_048_576, 1_024, 268_435_456),
  FETCH_LINE_STATS: z.enum(['auto', 'on', 'off']).default('auto'),
  REQUIRE_LINE_STATS: boolVar(false),

  ROUTES: z
    .preprocess((value) => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value; // routesDocument reports it as "expected object"
      }
    }, routesDocument)
    .optional(),
  CONFIG_FILE: z.string().trim().min(1).optional(),
  BRANCHES: listVar(['**']),
  TAGS: listVar([]),
  // Unset is open (documented); a value that lists nothing, like ",", is a mistake.
  REPO_ALLOWLIST: z
    .preprocess(
      coerceList,
      globList.min(1, 'must list at least one repository pattern. Leave it unset to allow every repository.'),
    )
    .default([]),
  SKIP_FORCED_PUSHES: boolVar(false),
  SKIP_MERGE_COMMITS: boolVar(true),
  SKIP_NON_DISTINCT: boolVar(true),
  IGNORE_AUTHORS: listVar([]),
  MAX_COMMITS_PER_PUSH: intVar(15, 1, 100),
  // Empty relays no pull request event at all, the same shape of switch TAGS uses.
  PR_ACTIONS: z.preprocess(coerceList, prActionList).default([...PR_ACTIONS]),
  PR_REVIEWS: boolVar(true),
  PR_SKIP_DRAFTS: boolVar(true),
  // Workers per-invocation subrequest ceiling (50 on Free). Node ignores it; 0 disables.
  SUBREQUEST_BUDGET: intVar(50, 0, 10_000_000),
  COMMIT_BODY_MAX_CHARS: intVar(4_000, 1, 100_000),
  CONTENT_MAX_BYTES: intVar(32_768, 512, 1_048_576),
  ENRICH_DEADLINE_MS: intVar(45_000, 1_000, MAX_MS),
  POST_RETRY_BUDGET_MS: intVar(20_000, 0, MAX_MS),
  RATELIMIT_WAIT_BUDGET_MS: intVar(60_000, 0, MAX_MS),
  MAX_QUEUE_DEPTH: intVar(500, 1, 1_000_000),
  MAX_QUEUE_BYTES: intVar(33_554_432, 65_536, 4_294_967_295),
  DEDUP_MAX_ENTRIES: intVar(10_000, 1, 10_000_000),
  DEDUP_TTL_HOURS: intVar(72, 1, 8_760),
  DROP_ALERT_WINDOW_MS: intVar(300_000, 1_000, MAX_MS),
  MAX_BODY_BYTES: intVar(26_214_400, 1_024, 104_857_600),
  RATE_LIMIT_PER_MINUTE: intVar(120, 1, 1_000_000),
  TRUSTED_PROXY_HOPS: intVar(0, 0, 8),
  WEBHOOK_PATH: z
    .string()
    .trim()
    .regex(/^\/[A-Za-z0-9\-._~/]*$/, 'must be an absolute path, e.g. /webhook')
    .default(DEFAULT_WEBHOOK_PATH),
  PORT: intVar(3_000, 1, 65_535),
  SHUTDOWN_DRAIN_MS: intVar(20_000, 0, 600_000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PAYLOADS: boolVar(false),
  HEALTH_TOKEN: healthTokenValue.optional(),
});

export type Config = z.infer<typeof configObject>;
export type ConfigInput = z.input<typeof configObject>;

function mergedTargets(cfg: Partial<Config>): Array<Partial<Record<'accountId' | 'bucketId' | 'chatId' | 'key', string>>> {
  const flat = {
    accountId: cfg.BASECAMP_ACCOUNT_ID,
    bucketId: cfg.BASECAMP_BUCKET_ID,
    chatId: cfg.BASECAMP_CHAT_ID,
    key: cfg.BASECAMP_CHATBOT_KEY,
  };
  const asTarget = (t: Target | undefined) => ({
    accountId: t?.accountId,
    bucketId: t?.bucketId,
    chatId: t?.chatId,
    key: t?.chatbotKey ?? t?.chatbotKeyEnv,
  });
  const shallow = (base: Record<string, string | undefined>, over: Record<string, string | undefined>) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) if (v !== undefined) out[k] = v;
    return out;
  };

  const defaults = shallow(flat, asTarget(cfg.ROUTES?.defaults?.target));
  const routes = (cfg.ROUTES?.routes ?? []).map((r) => shallow(defaults, asTarget(r.target)));
  return [defaults, ...routes];
}

function isComplete(t: Record<string, string | undefined>): boolean {
  return Boolean(t['accountId'] && t['bucketId'] && t['chatId'] && t['key']);
}

const FLAT_TARGET_KEYS = {
  accountId: 'BASECAMP_ACCOUNT_ID',
  bucketId: 'BASECAMP_BUCKET_ID',
  chatId: 'BASECAMP_CHAT_ID',
  key: 'BASECAMP_CHATBOT_KEY',
} as const;

const TARGET_FIELD_NAMES = {
  accountId: 'target.accountId',
  bucketId: 'target.bucketId',
  chatId: 'target.chatId',
  key: 'target.chatbotKeyEnv',
} as const;

/** A `GITHUB_TOKEN_*` variable no route references resolves nothing, so the boot
 *  summary and the REQUIRE_LINE_STATS check must both ignore it (7.3). */
export function resolvedTokenNames(source: EnvSource, cfg: Partial<Config>): string[] {
  const names = cfg.GITHUB_TOKEN === undefined ? [] : ['GITHUB_TOKEN'];
  for (const r of cfg.ROUTES?.routes ?? []) {
    if (r.githubTokenEnv && isSet(source, r.githubTokenEnv)) names.push(r.githubTokenEnv);
  }
  return [...new Set(names)];
}

export interface CrossFieldIssue {
  path: string;
  message: string;
}

/** Fields that failed their own validation are simply absent, so one missing key
 *  cannot hide the next - reporting one per redeploy is the anti-pattern 7.2 rejects. */
export function lenientConfig(values: Record<string, unknown>): Partial<Config> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(configObject.shape)) {
    const parsed = field.safeParse(values[key]);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  if (out['ROUTES'] === undefined && values['ROUTES'] !== undefined) {
    const salvaged = salvageRoutes(values['ROUTES']);
    if (salvaged !== undefined) out['ROUTES'] = salvaged;
  }
  return out as Partial<Config>;
}

/** One malformed route must not delete every other route from the view: a mistake
 *  in route 1 would otherwise hide an unset variable named by route 2 (7.2). */
function salvageRoutes(value: unknown): RoutesDocument | undefined {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const doc = raw as Record<string, unknown>;

  const routes = (Array.isArray(doc['routes']) ? doc['routes'] : [])
    .map((entry) => route.safeParse(entry))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  const defaults = routesDocument.shape.defaults.safeParse(doc['defaults']);
  const fallthrough = routesDocument.shape.fallthrough.safeParse(doc['fallthrough']);

  return {
    routes,
    fallthrough: fallthrough.success ? fallthrough.data : 'ignore',
    ...(defaults.success && defaults.data !== undefined ? { defaults: defaults.data } : {}),
  };
}

/** Each family carries its own value policy, which is why the kind is tracked
 *  rather than just the name. */
const NAMED_SECRET_VALUE = {
  githubToken: githubTokenValue,
  webhookSecret: webhookSecretValue,
  chatbotKey: chatbotKeyValue,
} as const;

type NamedSecretKind = keyof typeof NAMED_SECRET_VALUE;

interface NamedSecret {
  name: string;
  where: string;
  kind: NamedSecretKind;
}

/** A standalone function, not the `superRefine` of 7.5: zod stops running a
 *  refinement once a field it reads fails, reporting one missing key per redeploy. */
export function crossFieldIssues(source: EnvSource, cfg: Partial<Config>): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];

  const named: NamedSecret[] = [];
  const defaultKeyEnv = cfg.ROUTES?.defaults?.target?.chatbotKeyEnv;
  if (defaultKeyEnv) {
    named.push({ name: defaultKeyEnv, where: 'ROUTES.defaults.target.chatbotKeyEnv', kind: 'chatbotKey' });
  }
  (cfg.ROUTES?.routes ?? []).forEach((r, i) => {
    if (r.githubTokenEnv) {
      named.push({ name: r.githubTokenEnv, where: `ROUTES[${i}].githubTokenEnv`, kind: 'githubToken' });
    }
    if (r.webhookSecretEnv) {
      named.push({
        name: r.webhookSecretEnv,
        where: `ROUTES[${i}].webhookSecretEnv`,
        kind: 'webhookSecret',
      });
    }
    if (r.target?.chatbotKeyEnv) {
      named.push({
        name: r.target.chatbotKeyEnv,
        where: `ROUTES[${i}].target.chatbotKeyEnv`,
        kind: 'chatbotKey',
      });
    }
    const globalApiBase = cfg.GITHUB_API_BASE ?? 'https://api.github.com';
    const routeApiBase = r.githubApiBase ?? globalApiBase;
    try {
      const globalOrigin = new URL(globalApiBase).origin;
      const routeOrigin = new URL(routeApiBase).origin;
      if (routeOrigin !== globalOrigin && r.githubTokenEnv === undefined) {
        issues.push({
          path: `ROUTES[${i}].githubApiBase`,
          message:
            `points at ${routeOrigin}, which differs from GITHUB_API_BASE (${globalOrigin}), but githubTokenEnv is not set, so the global token would be sent to a different host. Set githubTokenEnv to a variable holding a token issued for that host.`,
        });
      }
    } catch {
      // Malformed URLs are caught by field-level validation.
    }
  });

  for (const { name, where, kind } of named) {
    // BASECAMP_CHATBOT_KEY may have been resolved out of BASECAMP_LINES_URL, in
    // which case it is set as far as the config is concerned but absent from the
    // raw environment - the two documented forms have to combine (7.3).
    const value =
      readValue(source, name) ??
      (kind === 'chatbotKey' && name === 'BASECAMP_CHATBOT_KEY' ? cfg.BASECAMP_CHATBOT_KEY : undefined);
    if (value === undefined) {
      issues.push({
        path: name,
        message: `is not set, and ${where} names it. Set that variable, or remove the field from that route.`,
      });
      continue;
    }
    // A route's own secret is subject to the same policy as the global one it
    // stands in for; otherwise webhookSecretEnv is a way around the 32-character
    // floor and the denylist (11.2).
    for (const issue of NAMED_SECRET_VALUE[kind].safeParse(value).error?.issues ?? []) {
      issues.push({ path: name, message: issue.message });
    }
  }

  issues.push(...duplicateWebhookSecretIssues(source, cfg));
  issues.push(...shadowedRouteIssues(cfg.ROUTES?.routes ?? []));

  const timeout = cfg.GITHUB_TIMEOUT_MS;
  const deadline = cfg.ENRICH_DEADLINE_MS;
  if (timeout !== undefined && deadline !== undefined) {
    const floor = timeout * 3 + 8_000;
    if (deadline < floor) {
      issues.push({
        path: 'ENRICH_DEADLINE_MS',
        message: `(${deadline}) is below GITHUB_TIMEOUT_MS * 3 + 8000 = ${floor}. The retry policy it is supposed to bound can never complete. Raise it to ${floor} or lower GITHUB_TIMEOUT_MS.`,
      });
    }
  }

  const targets = mergedTargets(cfg);
  if (!targets.some(isComplete)) {
    const best = targets[0] ?? {};
    for (const field of ['accountId', 'bucketId', 'chatId', 'key'] as const) {
      if (best[field]) continue;
      issues.push({
        path: FLAT_TARGET_KEYS[field],
        message: `is not set, and no route supplies its own ${TARGET_FIELD_NAMES[field]}.`,
      });
    }
  }

  if (
    cfg.REQUIRE_LINE_STATS &&
    cfg.FETCH_LINE_STATS !== undefined &&
    requireLineStatsViolated(true, cfg.FETCH_LINE_STATS, resolvedTokenNames(source, cfg).length > 0)
  ) {
    issues.push({
      path: 'REQUIRE_LINE_STATS',
      message:
        cfg.FETCH_LINE_STATS === 'off'
          ? 'is true, but FETCH_LINE_STATS is off. Set FETCH_LINE_STATS=on, or turn this off.'
          : 'is true, but FETCH_LINE_STATS=auto resolves to off because no GITHUB_TOKEN is set. Set a token, or turn this off.',
    });
  }

  // A drain shorter than one Basecamp POST kills the in-flight post it exists
  // to protect; longer than the platform grace period never runs at all.
  const drain = cfg.SHUTDOWN_DRAIN_MS;
  const postTimeout = cfg.BASECAMP_TIMEOUT_MS;
  if (drain !== undefined && postTimeout !== undefined && drain > 0 && drain < postTimeout) {
    issues.push({
      path: 'SHUTDOWN_DRAIN_MS',
      message: `(${drain}) is below BASECAMP_TIMEOUT_MS (${postTimeout}), so a drain always kills an in-flight post. Raise it, or set it to 0 to drain nothing.`,
    });
  }

  return issues;
}

/** One signature verifies under every name that holds the same value, so a route
 *  secret equal to another secret gives no isolation at all. The value is never echoed. */
function duplicateWebhookSecretIssues(source: EnvSource, cfg: Partial<Config>): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const seen = new Map<string, string>();
  const checked = new Set<string>();
  if (cfg.GITHUB_WEBHOOK_SECRET !== undefined) seen.set(cfg.GITHUB_WEBHOOK_SECRET, 'GITHUB_WEBHOOK_SECRET');
  for (const route of cfg.ROUTES?.routes ?? []) {
    const name = route.webhookSecretEnv;
    if (name === undefined || checked.has(name)) continue;
    checked.add(name);
    const value = readValue(source, name);
    if (value === undefined) continue;
    const other = seen.get(value);
    if (other !== undefined) {
      issues.push({
        path: name,
        message: `holds the same value as ${other}, so either secret can sign for the other's repositories. Give each its own secret.`,
      });
      continue;
    }
    seen.set(value, name);
  }
  return issues;
}

/** First match wins on repo alone, so a route an earlier pattern fully covers is
 *  dead, along with its secret and token isolation. Only certain coverage is
 *  flagged: a later literal the earlier glob accepts, or an earlier "**", "*" + "/*"
 *  or "owner/*" covering a later single-segment pattern under the same owner. */
function shadowedRouteIssues(routes: readonly Route[]): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const isLiteral = (p: string) => !/[*?]/.test(p);
  const covers = (earlier: string, later: string): boolean => {
    const e = earlier.toLowerCase();
    const l = later.toLowerCase();
    if (e === l || e === '**' || e === '*/*') return true;
    if (isLiteral(l)) return compileGlob(e)(l);
    const [owner, rest, ...extra] = e.split('/');
    const [laterOwner, laterRest, ...laterExtra] = l.split('/');
    return (
      rest === '*' &&
      extra.length === 0 &&
      owner !== undefined &&
      isLiteral(owner) &&
      owner === laterOwner &&
      laterRest !== undefined &&
      laterRest !== '**' &&
      laterExtra.length === 0
    );
  };
  routes.forEach((r, i) => {
    const j = routes.slice(0, i).findIndex((earlier) => covers(earlier.repo, r.repo));
    if (j < 0) return;
    issues.push({
      path: `ROUTES[${i}].repo`,
      message: `("${r.repo}") can never match: ROUTES[${j}].repo ("${routes[j]?.repo ?? ''}") comes first and covers every repository it would. Move the more specific route above it.`,
    });
  });
  return issues;
}
