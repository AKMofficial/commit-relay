/** The Node-only CONFIG_FILE reader is injected by the caller, so the same
 *  loader runs on both targets (7.1). */

import type { z } from 'zod';
import type { LogFn } from '../obs/log.ts';
import { payloadLoggingFields } from '../obs/log.ts';
import { registerSecrets } from '../security/redact.ts';
import { mapEnv, readValue, suffixedSecretNames, type EnvSource } from './env.ts';
import {
  REPOSITORY_URL,
  configObject,
  crossFieldIssues,
  lenientConfig,
  resolvedTokenNames,
  type Config,
} from './schema.ts';

export type { Config } from './schema.ts';

export interface Problem {
  key: string;
  message: string;
  hint?: string;
}

export interface LoadWarning {
  evt: string;
  fields?: Record<string, unknown>;
}

export type ConfigResult =
  | { ok: true; config: Config; summary: Record<string, unknown>; warnings: LoadWarning[] }
  | { ok: false; problems: Problem[]; missing: string[] };

export interface LoadOptions {
  readFile?: (path: string) => string;
}

const HINTS: Record<string, string> = {
  GITHUB_WEBHOOK_SECRET:
    'It is the "Secret" field on the GitHub webhook. Minimum 32 characters.\nGenerate one with: openssl rand -hex 32',
  BASECAMP_ACCOUNT_ID:
    'It is the number immediately after the host in any Basecamp URL.\nOr set BASECAMP_LINES_URL and let commit-relay read all four values from it.',
  BASECAMP_BUCKET_ID:
    'It is the number after /buckets/ in your Basecamp chatbot URL.\nOr set BASECAMP_LINES_URL and let commit-relay read all four values from it.',
  BASECAMP_CHAT_ID:
    'It is the number after /chats/ in your Basecamp chatbot URL.\nOr set BASECAMP_LINES_URL and let commit-relay read all four values from it.',
  BASECAMP_CHATBOT_KEY:
    'It is the token between /integrations/ and /buckets/ in your Basecamp chatbot URL.\nOr set BASECAMP_LINES_URL and let commit-relay read all four values from it.',
  BASECAMP_LINES_URL: 'Paste the whole posting URL Basecamp shows you, .json suffix optional.',
};

/** A route target's numeric ids are the one place JSON lets an operator write an
 *  unquoted number, so the hint is the corrected line rather than a rule. */
const NUMERIC_ID_EXAMPLES: Record<string, string> = {
  accountId: '1234567',
  bucketId: '2345678',
  chatId: '7654321',
};

const DOCS_URL = `${REPOSITORY_URL}#configuration`;

function issueKey(issue: z.core.$ZodIssue): string {
  const [head, ...rest] = issue.path;
  if (head === undefined) return 'configuration';
  if (head !== 'ROUTES' || rest.length === 0) return String(head);
  // The document's own `routes` array is an implementation detail of the
  // variable: an operator edits ROUTES[1], not ROUTES.routes[1].
  if (rest[0] === 'routes') rest.shift();
  return rest.reduce<string>(
    (acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : `${acc}.${String(part)}`),
    'ROUTES',
  );
}

function withHint(problem: Problem): Problem {
  const hint = HINTS[problem.key] ?? numericIdHint(problem);
  return hint === undefined ? problem : { ...problem, hint };
}

function numericIdHint(problem: Problem): string | undefined {
  if (!problem.message.startsWith('expected a numeric string')) return undefined;
  const field = problem.key.split('.').pop() ?? '';
  const example = NUMERIC_ID_EXAMPLES[field];
  return example === undefined ? undefined : `Quote it: "${field}": "${example}"`;
}

/** A route path names a place inside a document, so it is punctuated as a label;
 *  a bare variable name reads as the subject of its sentence (7.2). */
function isPathKey(key: string): boolean {
  return key.includes('.') || key.includes('[');
}

function toProblems(issues: readonly z.core.$ZodIssue[]): Problem[] {
  return issues.map((issue) => withHint({ key: issueKey(issue), message: issue.message }));
}

/** The numbered human list of 7.2: every problem at once, never a stack trace,
 *  and never a secret's value. */
export function formatProblems(problems: readonly Problem[]): string {
  const lines = ['commit-relay: configuration is invalid. Fix these and restart.', ''];
  problems.forEach((problem, i) => {
    const separator = isPathKey(problem.key) ? ': ' : ' ';
    lines.push(`  ${i + 1}. ${problem.key}${separator}${problem.message}`);
    if (problem.hint) for (const hintLine of problem.hint.split('\n')) lines.push(`     ${hintLine}`);
  });
  lines.push('');
  lines.push(`${problems.length} problem${problems.length === 1 ? '' : 's'}. See ${DOCS_URL}`);
  lines.push('');
  return lines.join('\n');
}

function reachableSecrets(source: EnvSource, config: Config): string[] {
  const values: Array<string | undefined> = [
    config.GITHUB_WEBHOOK_SECRET,
    config.GITHUB_TOKEN,
    config.BASECAMP_CHATBOT_KEY,
    config.HEALTH_TOKEN,
  ];
  for (const name of suffixedSecretNames(source)) values.push(readValue(source, name));
  // chatbotKeyEnv has no enforced prefix (7.3), so suffixedSecretNames cannot
  // find it by name; a route's key would otherwise never reach the redactor.
  for (const route of config.ROUTES?.routes ?? []) {
    values.push(route.target?.chatbotKey);
    const named = route.target?.chatbotKeyEnv;
    if (named !== undefined) values.push(readValue(source, named));
  }
  const defaultTarget = config.ROUTES?.defaults?.target;
  values.push(defaultTarget?.chatbotKey);
  if (defaultTarget?.chatbotKeyEnv !== undefined) {
    values.push(readValue(source, defaultTarget.chatbotKeyEnv));
  }
  return values.filter((value): value is string => typeof value === 'string');
}

function summarize(source: EnvSource, config: Config): Record<string, unknown> {
  const tokens = resolvedTokenNames(source, config);
  return {
    // Length only: enough to catch a dashboard that truncated or re-wrapped the
    // secret, never a prefix of it (11.2).
    webhookSecret: `set (${config.GITHUB_WEBHOOK_SECRET.length} chars)`,
    routes: config.ROUTES?.routes.length ?? 0,
    fallthrough: config.ROUTES?.fallthrough ?? 'ignore',
    defaultTarget: {
      accountId: config.BASECAMP_ACCOUNT_ID ?? null,
      bucketId: config.BASECAMP_BUCKET_ID ?? null,
      chatId: config.BASECAMP_CHAT_ID ?? null,
      chatbotKey: config.BASECAMP_CHATBOT_KEY ? '***' : null,
    },
    branches: config.BRANCHES,
    tags: config.TAGS,
    lineStats: config.FETCH_LINE_STATS === 'auto' ? (tokens.length > 0 ? 'on' : 'off') : config.FETCH_LINE_STATS,
    tokens,
    maxCommitsPerPush: config.MAX_COMMITS_PER_PUSH,
    contentMaxBytes: config.CONTENT_MAX_BYTES,
  };
}

/**
 * Merge (env > ROUTES/CONFIG_FILE JSON > built-in defaults), then validate once.
 * Defaults live in the schema, so this function only decides where the routing
 * document comes from.
 */
export function loadConfig(source: EnvSource, options: LoadOptions = {}): ConfigResult {
  const { values, linesUrlInvalid } = mapEnv(source);
  const warnings: LoadWarning[] = [];
  const preProblems: Problem[] = [];

  const routesVar = readValue(source, 'ROUTES');
  const configFile = readValue(source, 'CONFIG_FILE');

  if (routesVar !== undefined && configFile !== undefined) {
    warnings.push({ evt: 'config_file_shadowed', fields: { path: configFile } });
  } else if (routesVar === undefined && configFile !== undefined) {
    if (options.readFile === undefined) {
      preProblems.push({
        key: 'CONFIG_FILE',
        message: 'is set, but this target has no filesystem. Put the same JSON in the ROUTES variable instead.',
      });
    } else {
      try {
        values['ROUTES'] = options.readFile(configFile);
      } catch (err) {
        preProblems.push({ key: 'CONFIG_FILE', message: (err as Error).message });
      }
    }
  }

  if (linesUrlInvalid) {
    // mapEnv could not split it into the four values, so the schema sees the
    // discrete variables as missing; say why once, by name.
    values['BASECAMP_LINES_URL'] = source['BASECAMP_LINES_URL']?.trim();
  }

  const parsed = configObject.safeParse(values);
  // The cross-field checks run against a best-effort view rather than only a
  // fully valid one, so one missing key never hides the next (7.2).
  const view = parsed.success ? parsed.data : lenientConfig(values);
  const crossField = crossFieldIssues(source, view).map(
    (issue): Problem => withHint({ key: issue.path, message: issue.message }),
  );

  if (!parsed.success || preProblems.length > 0 || crossField.length > 0) {
    const problems = [
      ...preProblems,
      ...(parsed.success ? [] : toProblems(parsed.error.issues)),
      ...crossField,
    ];
    const missing = [...new Set(problems.map((p) => p.key))];
    return { ok: false, problems, missing };
  }

  const config = parsed.data;
  registerSecrets(reachableSecrets(source, config));

  if (config.REPO_ALLOWLIST.length === 0) warnings.push({ evt: 'repo_allowlist_open' });
  const inlineKey =
    config.ROUTES?.defaults?.target?.chatbotKey !== undefined ||
    (config.ROUTES?.routes ?? []).some((r) => r.target?.chatbotKey !== undefined);
  if (inlineKey) warnings.push({ evt: 'chatbotkey_inline_in_config' });
  if (config.LOG_PAYLOADS) {
    warnings.push({ evt: 'log_payloads_enabled', fields: payloadLoggingFields(config) });
  }

  return { ok: true, config, summary: summarize(source, config), warnings };
}

/** Workers cannot validate at module load, because bindings are only reachable
 *  from a request. Keyed on the source object's identity, so one isolate
 *  validates once and every later call returns the identical object (7.2). */
const cache = new WeakMap<object, ConfigResult>();

export function tryGetConfig(source: EnvSource, options: LoadOptions = {}): ConfigResult {
  const cached = cache.get(source);
  if (cached) return cached;
  const result = loadConfig(source, options);
  cache.set(source, result);
  return result;
}

export class ConfigError extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(formatProblems(problems));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Seam 2 (4.3). */
export function getConfig(source: EnvSource, options: LoadOptions = {}): Config {
  const result = tryGetConfig(source, options);
  if (!result.ok) throw new ConfigError(result.problems);
  return result.config;
}

/** 7.2: exactly one info line on success, followed by every load warning. */
export function logConfigLoaded(
  log: LogFn,
  loaded: Extract<ConfigResult, { ok: true }>,
  asyncTier: string,
): void {
  log('info', 'config_loaded', { asyncTier, ...loaded.summary });
  for (const warning of loaded.warnings) log('warn', warning.evt, warning.fields);
}
