import { describe, expect, it, vi } from 'vitest';
import { registerSecrets } from '../security/redact.ts';
import {
  createLogger,
  loggerFor,
  parseLevel,
  payloadLoggingFields,
  payloadsEnabled,
  resetThrottle,
  throttled,
  warnPayloadLogging,
} from './log.ts';

function capture(fn: () => void): string[] {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}

describe('createLogger', () => {
  it('writes one JSON object per line with every required field', () => {
    const lines = capture(() => {
      const log = createLogger({ level: 'info', target: 'workers' });
      log('info', 'message_posted', { repo: 'your-org/your-repo', seq: 0 });
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).not.toContain('\n');

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).slice(0, 6)).toEqual(['t', 'lvl', 'evt', 'svc', 'ver', 'tgt']);
    expect(parsed.lvl).toBe('info');
    expect(parsed.evt).toBe('message_posted');
    expect(parsed.svc).toBe('commit-relay');
    expect(parsed.ver).toBe('0.1.0');
    expect(parsed.tgt).toBe('workers');
    expect(parsed.repo).toBe('your-org/your-repo');
    expect(parsed.seq).toBe(0);
    expect(typeof parsed.t).toBe('string');
  });

  it('filters everything below the configured level', () => {
    const lines = capture(() => {
      const log = createLogger({ level: 'warn', target: 'node' });
      log('trace', 'payload_received');
      log('debug', 'github_ratelimit');
      log('info', 'message_posted');
      log('warn', 'basecamp_retry');
      log('error', 'message_dropped');
      log('fatal', 'config_invalid');
    });

    expect(lines.map((l) => (JSON.parse(l) as { evt: string }).evt)).toEqual([
      'basecamp_retry',
      'message_dropped',
      'config_invalid',
    ]);
  });

  it('redacts a chatbot key inside a URL and a registered literal', () => {
    registerSecrets(['s3cr3t-webhook-value']);

    const lines = capture(() => {
      const log = createLogger({ level: 'debug', target: 'node' });
      log('debug', 'boot', {
        url: 'https://3.basecamp.com/1/integrations/AbCdEfGhIjKlMnOpQrStUvWx/buckets/2/chats/3/lines',
        secret: 's3cr3t-webhook-value',
      });
    });

    const line = lines[0] as string;
    expect(line).toContain('/integrations/***');
    expect(line).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
    expect(line).not.toContain('s3cr3t-webhook-value');
    expect(line).toContain('***');

    registerSecrets([]);
  });

  it('carries every event-specific field through, flat and one level deep', () => {
    const lines = capture(() => {
      const log = createLogger({ level: 'info', target: 'node', now: () => 0 });
      log('info', 'message_posted', {
        delivery: '6f1a',
        repo: 'your-org/your-repo',
        ref: 'refs/heads/main',
        sha: 'a1b2c3d',
        seq: 0,
        attempt: 1,
        status: 201,
        ms: 213,
        reason: undefined,
      });
    });

    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed).toEqual({
      t: '1970-01-01T00:00:00.000Z',
      lvl: 'info',
      evt: 'message_posted',
      svc: 'commit-relay',
      ver: '0.1.0',
      tgt: 'node',
      delivery: '6f1a',
      repo: 'your-org/your-repo',
      ref: 'refs/heads/main',
      sha: 'a1b2c3d',
      seq: 0,
      attempt: 1,
      status: 201,
      ms: 213,
    });
  });

  it('shortens a full 40-hex sha to the seven-character id (14.1)', () => {
    const lines = capture(() => {
      const log = createLogger({ level: 'info', target: 'node', now: () => 0 });
      log('info', 'commit_duplicate_skipped', {
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        ref: 'refs/heads/main',
      });
    });

    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed['sha']).toBe('a1b2c3d');
    expect(parsed['ref']).toBe('refs/heads/main');
  });

  it('never lets a field override one of the six required ones', () => {
    const lines = capture(() => {
      const log = createLogger({ level: 'info', target: 'node' });
      log('info', 'boot', { svc: 'evil', lvl: 'trace', tgt: 'workers' });
    });

    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.svc).toBe('commit-relay');
    expect(parsed.lvl).toBe('info');
    expect(parsed.tgt).toBe('node');
  });

  it('drops trace lines unless LOG_PAYLOADS is on as well', () => {
    const gated = capture(() => {
      createLogger({ level: 'trace', target: 'node' })('trace', 'payload_received', { bytes: 1 });
    });
    expect(gated).toHaveLength(0);

    const allowed = capture(() => {
      createLogger({ level: 'trace', target: 'node', payloads: true })('trace', 'payload_received', {
        bytes: 1,
      });
    });
    expect(allowed).toHaveLength(1);
    expect((JSON.parse(allowed[0] as string) as { evt: string }).evt).toBe('payload_received');

    const belowLevel = capture(() => {
      createLogger({ level: 'debug', target: 'node', payloads: true })('trace', 'payload_received');
    });
    expect(belowLevel).toHaveLength(0);
  });

  it('redacts a registered secret whatever field name carries it', () => {
    registerSecrets(['s3cr3t-webhook-value', 'health-token-abcdefgh']);

    const lines = capture(() => {
      const log = createLogger({ level: 'info', target: 'node' });
      log('info', 'boot', {
        somethingUnexpected: 'prefix s3cr3t-webhook-value suffix',
        note: 'health-token-abcdefgh',
        auth: 'Bearer ghp_0123456789abcdefghij',
        sig: `sha256=${'a'.repeat(64)}`,
      });
    });

    const line = lines[0] as string;
    expect(line).not.toContain('s3cr3t-webhook-value');
    expect(line).not.toContain('health-token-abcdefgh');
    expect(line).not.toContain('ghp_0123456789abcdefghij');
    expect(line).not.toContain('a'.repeat(64));
    expect(line).toContain('sha256=***');

    registerSecrets([]);
  });
});

describe('the delivery field', () => {
  it('emits the job field deliveryId under the 14.1 name', () => {
    const lines = capture(() => {
      const log = createLogger({ level: 'info', target: 'workers' });
      log('info', 'message_posted', { deliveryId: '6f1a0000-0000-0000-0000-000000000000', seq: 0 });
    });

    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.delivery).toBe('6f1a0000-0000-0000-0000-000000000000');
    expect(parsed).not.toHaveProperty('deliveryId');
  });

  it('leaves a line that already uses delivery alone', () => {
    const lines = capture(() => {
      createLogger({ level: 'info', target: 'node' })('info', 'push_skipped', { delivery: 'abc' });
    });
    expect((JSON.parse(lines[0] as string) as { delivery: string }).delivery).toBe('abc');
  });
});

describe('loggerFor', () => {
  it('carries LOG_PAYLOADS from config, so the trace gate is reachable in production', () => {
    const off = capture(() => {
      loggerFor({ LOG_LEVEL: 'trace', LOG_PAYLOADS: false }, 'node')('trace', 'payload_received');
    });
    expect(off).toHaveLength(0);

    const on = capture(() => {
      loggerFor({ LOG_LEVEL: 'trace', LOG_PAYLOADS: true }, 'node')('trace', 'payload_received', {
        bytes: 41_822,
      });
    });
    const parsed = JSON.parse(on[0] as string) as Record<string, unknown>;
    expect(parsed.evt).toBe('payload_received');
    expect(parsed.tgt).toBe('node');
    expect(parsed.bytes).toBe(41_822);
  });

  it('falls back to info for an unparseable level', () => {
    const lines = capture(() => {
      const log = loggerFor({ LOG_LEVEL: 'shout', LOG_PAYLOADS: false }, 'workers');
      log('debug', 'github_ratelimit');
      log('info', 'server_listening');
    });
    expect(lines).toHaveLength(1);
  });
});

describe('payloadsEnabled', () => {
  it('is true only for the trace + LOG_PAYLOADS combination', () => {
    expect(payloadsEnabled({ LOG_LEVEL: 'trace', LOG_PAYLOADS: true })).toBe(true);
    expect(payloadsEnabled({ LOG_LEVEL: 'trace', LOG_PAYLOADS: false })).toBe(false);
    expect(payloadsEnabled({ LOG_LEVEL: 'debug', LOG_PAYLOADS: true })).toBe(false);
    expect(payloadsEnabled({ LOG_LEVEL: 'nonsense', LOG_PAYLOADS: true })).toBe(false);
  });
});

describe('throttled', () => {
  it('passes once per key per window', () => {
    resetThrottle();
    const hour = 3_600_000;
    expect(throttled('auth:your-org/your-repo', hour, 0)).toBe(true);
    expect(throttled('auth:your-org/your-repo', hour, 1_000)).toBe(false);
    expect(throttled('auth:your-org/other', hour, 1_000)).toBe(true);
    expect(throttled('auth:your-org/your-repo', hour, hour)).toBe(true);
    resetThrottle();
    expect(throttled('auth:your-org/your-repo', hour, hour)).toBe(true);
  });
});

describe('payloadLoggingFields', () => {
  it('names what the trace combination exposes, for the boot warning and the loader alike', () => {
    const fields = payloadLoggingFields({ LOG_LEVEL: 'trace', LOG_PAYLOADS: true });
    expect(fields.effective).toBe(true);
    expect(String(fields.warning)).toContain('private-repo commit messages and file paths');
    expect(payloadLoggingFields({ LOG_LEVEL: 'info', LOG_PAYLOADS: true }).effective).toBe(false);
  });
});

describe('warnPayloadLogging', () => {
  it('warns only when LOG_PAYLOADS is set, naming what it exposes', () => {
    const quiet = capture(() => {
      const log = createLogger({ level: 'info', target: 'node' });
      warnPayloadLogging({ LOG_LEVEL: 'trace', LOG_PAYLOADS: false }, log);
    });
    expect(quiet).toHaveLength(0);

    const noisy = capture(() => {
      const log = createLogger({ level: 'info', target: 'node' });
      warnPayloadLogging({ LOG_LEVEL: 'trace', LOG_PAYLOADS: true }, log);
    });
    const parsed = JSON.parse(noisy[0] as string) as Record<string, unknown>;
    expect(parsed.evt).toBe('log_payloads_enabled');
    expect(parsed.effective).toBe(true);
    expect(String(parsed.warning)).toContain('commit messages');
  });

  it('reports the warning as ineffective below trace level', () => {
    const lines = capture(() => {
      const log = createLogger({ level: 'info', target: 'node' });
      warnPayloadLogging({ LOG_LEVEL: 'info', LOG_PAYLOADS: true }, log);
    });
    expect((JSON.parse(lines[0] as string) as { effective: boolean }).effective).toBe(false);
  });
});

describe('parseLevel', () => {
  it('accepts known levels and falls back otherwise', () => {
    expect(parseLevel('DEBUG')).toBe('debug');
    expect(parseLevel('nonsense')).toBe('info');
    expect(parseLevel(undefined, 'warn')).toBe('warn');
  });
});
