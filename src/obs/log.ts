export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogFn = (
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>,
) => void;
import { redactText } from '../security/redact.ts';
// The `ver` field is the package version (14.1); read it from the manifest so
// the two cannot drift on a version bump.
import pkg from '../../package.json' with { type: 'json' };

export type Target = 'workers' | 'node';

const ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const SERVICE = 'commit-relay';
const VERSION: string = pkg.version;

export interface LoggerOptions {
  level: LogLevel;
  target: Target;
  /** Full payloads are trace-level AND gated on LOG_PAYLOADS (14.2). */
  payloads?: boolean;
  version?: string;
  now?: () => number;
}

/** 14.1 names the GitHub delivery GUID `delivery` while call sites carry
 *  `deliveryId`, so log.ts, which owns the field names, normalises it. */
const RENAMED: Record<string, string> = { deliveryId: 'delivery' };

const FULL_SHA = /^[0-9a-f]{40}$/;

/** 14.1 logs the short id. Normalising here, where the field names are already
 *  owned, keeps every `sha:` call site from having to remember `.slice(0, 7)`. */
function normalize(name: string, value: unknown): unknown {
  if (name !== 'sha' || typeof value !== 'string') return value;
  return FULL_SHA.test(value) ? value.slice(0, 7) : value;
}

export function parseLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const v = (value ?? '').toLowerCase();
  return v in ORDER ? (v as LogLevel) : fallback;
}

/**
 * `t lvl evt svc ver tgt` are written first, so a truncated line still
 * identifies itself (14.1).
 */
export function createLogger(options: LoggerOptions): LogFn {
  const threshold = ORDER[options.level];
  const version = options.version ?? VERSION;
  const now = options.now ?? Date.now;

  const payloads = options.payloads ?? false;

  return (level, event, fields) => {
    if (ORDER[level] < threshold) return;
    if (level === 'trace' && !payloads) return;

    const line: Record<string, unknown> = {
      t: new Date(now()).toISOString(),
      lvl: level,
      evt: event,
      svc: SERVICE,
      ver: version,
      tgt: options.target,
    };

    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const name = RENAMED[key] ?? key;
        if (name in line) continue; // the six required fields are not overridable
        line[name] = normalize(name, value);
      }
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(line);
    } catch {
      // A field carrying a cycle or a BigInt must not take the process down.
      serialized = JSON.stringify({ ...line, evt: event, unserializable: true });
    }

    // Redaction runs on the serialized line, so it cannot be bypassed by
    // choosing an unusual field name (11.3).
    console.log(redactText(serialized));
  };
}

const lastEmitted = new Map<string, number>();

/**
 * True at most once per key per window, so repeated authentication failures
 * collapse to once per repo per hour rather than once per commit (14.2).
 */
export function throttled(key: string, windowMs: number, now: number): boolean {
  const previous = lastEmitted.get(key);
  if (previous !== undefined && now - previous < windowMs) return false;
  lastEmitted.set(key, now);
  return true;
}

export function resetThrottle(): void {
  lastEmitted.clear();
}

export interface PayloadLoggingConfig {
  LOG_LEVEL: string;
  LOG_PAYLOADS: boolean;
}

/** The single wording of the boot warning, so the config loader's warning list
 *  and warnPayloadLogging cannot drift apart (7.3, 14.2). */
export function payloadLoggingFields(cfg: PayloadLoggingConfig): Record<string, unknown> {
  return {
    level: cfg.LOG_LEVEL,
    effective: cfg.LOG_LEVEL === 'trace',
    warning:
      'raw webhook bodies are written to your log sink, including private-repo commit messages and file paths',
  };
}

export function warnPayloadLogging(cfg: PayloadLoggingConfig, log: LogFn): void {
  if (!cfg.LOG_PAYLOADS) return;
  log('warn', 'log_payloads_enabled', payloadLoggingFields(cfg));
}

/** True only for trace + LOG_PAYLOADS, so a call site can skip building an
 *  expensive trace field rather than hand it to a gate that discards it (14.2). */
export function payloadsEnabled(cfg: PayloadLoggingConfig): boolean {
  return cfg.LOG_PAYLOADS && parseLevel(cfg.LOG_LEVEL) === 'trace';
}

/** The only logger constructor the running targets use, so the LOG_PAYLOADS
 *  gate cannot be reachable in the unit tests and unreachable in production. */
export function loggerFor(cfg: PayloadLoggingConfig, target: Target): LogFn {
  return createLogger({
    level: parseLevel(cfg.LOG_LEVEL),
    target,
    payloads: cfg.LOG_PAYLOADS,
  });
}
