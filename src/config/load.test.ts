import { describe, expect, it } from 'vitest';
import { formatProblems, getConfig, loadConfig, tryGetConfig, type ConfigResult } from './load.ts';
import { redactText } from '../security/redact.ts';
import { PUBLISHED_SECRET_LITERALS } from './schema.ts';
import { parseLinesUrl } from './lines-url.ts';
import { healthz } from '../http/health.ts';

const SECRET = 'test-webhook-secret-0000000000000000000000000000';

function base(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_WEBHOOK_SECRET: SECRET,
    BASECAMP_ACCOUNT_ID: '1234567',
    BASECAMP_CHATBOT_KEY: 'chatbot-key-value',
    BASECAMP_BUCKET_ID: '2345678',
    BASECAMP_CHAT_ID: '7654321',
    ...extra,
  };
}

function fail(source: Record<string, string | undefined>): Extract<ConfigResult, { ok: false }> {
  const result = loadConfig(source);
  if (result.ok) throw new Error('expected the configuration to be rejected');
  return result;
}

function pass(source: Record<string, string | undefined>): Extract<ConfigResult, { ok: true }> {
  const result = loadConfig(source);
  if (!result.ok) throw new Error(formatProblems(result.problems));
  return result;
}

describe('required keys', () => {
  it('names each missing required key in a numbered list', () => {
    const result = fail({});
    expect(result.missing).toContain('GITHUB_WEBHOOK_SECRET');
    const text = formatProblems(result.problems);
    expect(text).toContain('1. GITHUB_WEBHOOK_SECRET is not set.');
    expect(text).toContain('openssl rand -hex 32');
    expect(text).not.toContain('Error:');
    expect(text).not.toContain('    at ');
  });

  it('reports three missing keys in one pass, not the first alone', () => {
    const result = fail({ GITHUB_WEBHOOK_SECRET: SECRET, BASECAMP_ACCOUNT_ID: '1234567' });
    expect(result.missing).toEqual(
      expect.arrayContaining(['BASECAMP_BUCKET_ID', 'BASECAMP_CHAT_ID', 'BASECAMP_CHATBOT_KEY']),
    );
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
    expect(formatProblems(result.problems)).toContain('3 problems.');
  });

  it('serves the whole missing list from GET /healthz with a 500', () => {
    const source = { BASECAMP_ACCOUNT_ID: '1234567' };
    const response = healthz(source);
    expect(response.code).toBe(500);
    expect(response.body).toEqual({
      status: 'config_invalid',
      missing: expect.arrayContaining(['GITHUB_WEBHOOK_SECRET', 'BASECAMP_CHAT_ID']),
    });
  });

  it('answers 200 when the configuration is valid', () => {
    expect(healthz(base()).code).toBe(200);
  });

  it('the four flat BASECAMP_* vars alone are enough to boot', () => {
    const result = pass(base());
    expect(result.config.ROUTES).toBeUndefined();
    expect(result.config.BASECAMP_CHAT_ID).toBe('7654321');
  });
});

describe('trimming and the empty check', () => {
  it('treats a whitespace-only value as missing', () => {
    const result = fail(base({ GITHUB_WEBHOOK_SECRET: '   \n ' }));
    expect(result.missing).toContain('GITHUB_WEBHOOK_SECRET');
  });

  it('trims a pasted trailing newline off a good value', () => {
    const result = pass(base({ GITHUB_WEBHOOK_SECRET: `${SECRET}\n` }));
    expect(result.config.GITHUB_WEBHOOK_SECRET).toBe(SECRET);
  });
});

describe('coercion of string bindings', () => {
  it('accepts "15" and " 15 "', () => {
    expect(pass(base({ MAX_COMMITS_PER_PUSH: '15' })).config.MAX_COMMITS_PER_PUSH).toBe(15);
    expect(pass(base({ MAX_COMMITS_PER_PUSH: ' 15 ' })).config.MAX_COMMITS_PER_PUSH).toBe(15);
  });

  it.each(['fifteen', '', '1e9'])('rejects %o by name', (value) => {
    const result = fail(base({ MAX_COMMITS_PER_PUSH: value }));
    expect(result.missing).toContain('MAX_COMMITS_PER_PUSH');
  });

  it('coerces booleans and comma-separated lists', () => {
    const config = pass(base({ SKIP_MERGE_COMMITS: 'false', BRANCHES: 'main, release/* ,' })).config;
    expect(config.SKIP_MERGE_COMMITS).toBe(false);
    expect(config.BRANCHES).toEqual(['main', 'release/*']);
  });

  it('rejects a boolean that is neither true nor false', () => {
    expect(fail(base({ SKIP_MERGE_COMMITS: 'maybe' })).missing).toContain('SKIP_MERGE_COMMITS');
  });

  it('applies the documented default when a variable is unset', () => {
    const config = pass(base()).config;
    expect(config.MAX_COMMITS_PER_PUSH).toBe(15);
    expect(config.GITHUB_CONCURRENCY).toBe(4);
    expect(config.BASECAMP_MIN_INTERVAL_MS).toBe(250);
    expect(config.DEDUP_TTL_HOURS).toBe(72);
    expect(config.MAX_BODY_BYTES).toBe(26_214_400);
    expect(config.TRUSTED_PROXY_HOPS).toBe(0);
    expect(config.WEBHOOK_PATH).toBe('/webhook');
    expect(config.BRANCHES).toEqual(['**']);
    expect(config.TAGS).toEqual([]);
    expect(config.PR_ACTIONS).toEqual(['opened', 'closed', 'reopened', 'ready_for_review']);
    expect(config.PR_REVIEWS).toBe(true);
    expect(config.PR_SKIP_DRAFTS).toBe(true);
  });
});

describe('pull request knobs', () => {
  it('parses PR_ACTIONS empty, trimmed lists, and rejects PR_REVIEWS=maybe', () => {
    expect(pass(base({ PR_ACTIONS: '' })).config.PR_ACTIONS).toEqual([]);
    expect(pass(base({ PR_ACTIONS: 'opened, closed' })).config.PR_ACTIONS).toEqual(['opened', 'closed']);
    expect(fail(base({ PR_REVIEWS: 'maybe' })).missing).toContain('PR_REVIEWS');
  });

  it('rejects a PR_ACTIONS entry that is not a supported action, globs included', () => {
    expect(fail(base({ PR_ACTIONS: '*' })).missing).toContain('PR_ACTIONS');
    expect(fail(base({ PR_ACTIONS: 'opened,synchronize' })).missing).toContain('PR_ACTIONS');
  });
});

describe('the webhook secret policy', () => {
  it('rejects a secret shorter than 32 characters, whatever NODE_ENV says', () => {
    const result = fail(base({ GITHUB_WEBHOOK_SECRET: 'short', NODE_ENV: 'development' }));
    expect(result.missing).toContain('GITHUB_WEBHOOK_SECRET');
    expect(formatProblems(result.problems)).toContain('at least 32 characters');
  });

  it.each(PUBLISHED_SECRET_LITERALS)('refuses the published literal %s', (literal) => {
    const result = fail(base({ GITHUB_WEBHOOK_SECRET: literal }));
    expect(result.missing).toContain('GITHUB_WEBHOOK_SECRET');
  });

  it('does not deny the test harness secret, which is never offered to an operator', () => {
    expect(PUBLISHED_SECRET_LITERALS).not.toContain(SECRET);
    expect(pass(base()).config.GITHUB_WEBHOOK_SECRET).toBe(SECRET);
  });

  it('refuses a published literal as the chatbot key, not only as the webhook secret', () => {
    const result = fail(base({ BASECAMP_CHATBOT_KEY: 'PLACEHOLDERKEY0123456789' }));
    expect(result.missing).toContain('BASECAMP_CHATBOT_KEY');
    expect(formatProblems(result.problems)).toContain('PLACEHOLDERKEY0123456789');
  });

  it('names the file a published literal actually appears in', () => {
    const result = fail(base({ GITHUB_WEBHOOK_SECRET: 'replace-me-with-openssl-rand-hex-32' }));
    expect(formatProblems(result.problems)).toContain('.env.example and .dev.vars.example');
  });

  it('holds a route webhook secret to the same floor and denylist', () => {
    const routes = JSON.stringify({
      routes: [{ repo: 'a/b', webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_OTHERORG' }],
    });
    const short = fail(base({ ROUTES: routes, GITHUB_WEBHOOK_SECRET_OTHERORG: 'x' }));
    expect(formatProblems(short.problems)).toContain('at least 32 characters');
    const published = fail(
      base({ ROUTES: routes, GITHUB_WEBHOOK_SECRET_OTHERORG: 'dev-secret-do-not-use-in-production' }),
    );
    expect(published.missing).toContain('GITHUB_WEBHOOK_SECRET_OTHERORG');
  });

  it('refuses a published literal in a suffixed chatbot key', () => {
    const result = fail(
      base({
        BASECAMP_CHATBOT_KEY_INFRA: 'PLACEHOLDERKEY0123456789',
        ROUTES: JSON.stringify({
          routes: [{ repo: 'a/b', target: { chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY_INFRA' } }],
        }),
      }),
    );
    expect(result.missing).toContain('BASECAMP_CHATBOT_KEY_INFRA');
  });

  it('never puts a secret value in a message', () => {
    const secrets = {
      GITHUB_WEBHOOK_SECRET: 'sekrit-webhook-value',
      BASECAMP_CHATBOT_KEY: 'sekrit-chatbot-key-value',
      GITHUB_TOKEN: 'sekrit-token-value',
      HEALTH_TOKEN: 'sekrit-health-value',
    };
    const result = fail({ ...base(), ...secrets });
    const text = formatProblems(result.problems);
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(JSON.stringify(result.missing)).not.toContain('sekrit');
  });
});

describe('BASECAMP_LINES_URL', () => {
  const parts = {
    accountId: '1234567',
    chatbotKey: 'EXAMPLEKEY0123456789ABCD',
    bucketId: '2345678',
    chatId: '7654321',
  };

  it.each([
    'https://3.basecampapi.com/1234567/integrations/EXAMPLEKEY0123456789ABCD/buckets/2345678/chats/7654321/lines.json',
    'https://3.basecampapi.com/1234567/integrations/EXAMPLEKEY0123456789ABCD/buckets/2345678/chats/7654321/lines',
    'https://3.basecamp.com/1234567/integrations/EXAMPLEKEY0123456789ABCD/buckets/2345678/chats/7654321/lines.json',
    'https://3.basecamp.com/1234567/integrations/EXAMPLEKEY0123456789ABCD/buckets/2345678/chats/7654321/lines',
  ])('parses %s', (url) => {
    expect(parseLinesUrl(url)).toEqual(parts);
  });

  it.each([
    'https://example.com/1234567/integrations/K/buckets/2/chats/3/lines.json',
    'https://3.basecampapi.com/1234567/integrations/K/buckets/2/chats/3/lines.txt',
    'not a url',
  ])('returns null for %s', (url) => {
    expect(parseLinesUrl(url)).toBeNull();
  });

  it('returns null for a malformed percent escape in the chatbot key', () => {
    expect(
      parseLinesUrl(
        'https://3.basecampapi.com/1234567/integrations/abc%zz/buckets/2345678/chats/7654321/lines.json',
      ),
    ).toBeNull();
  });

  it('wins over the four discrete variables', () => {
    const config = pass({
      GITHUB_WEBHOOK_SECRET: SECRET,
      BASECAMP_ACCOUNT_ID: '9999999',
      BASECAMP_CHATBOT_KEY: 'ignored-key-value',
      BASECAMP_BUCKET_ID: '9999999',
      BASECAMP_CHAT_ID: '9999999',
      BASECAMP_LINES_URL:
        'https://3.basecampapi.com/1234567/integrations/EXAMPLEKEY0123456789ABCD/buckets/2345678/chats/7654321/lines.json',
    }).config;
    expect(config.BASECAMP_ACCOUNT_ID).toBe(parts.accountId);
    expect(config.BASECAMP_CHATBOT_KEY).toBe(parts.chatbotKey);
    expect(config.BASECAMP_BUCKET_ID).toBe(parts.bucketId);
    expect(config.BASECAMP_CHAT_ID).toBe(parts.chatId);
  });

  it('is alone sufficient to boot', () => {
    expect(
      pass({
        GITHUB_WEBHOOK_SECRET: SECRET,
        BASECAMP_LINES_URL:
          'https://3.basecampapi.com/1234567/integrations/EXAMPLEKEY0123456789ABCD/buckets/2345678/chats/7654321/lines.json',
      }).config.BASECAMP_CHAT_ID,
    ).toBe('7654321');
  });

  it('reports an unparseable value by name', () => {
    const result = fail({ GITHUB_WEBHOOK_SECRET: SECRET, BASECAMP_LINES_URL: 'https://3.basecamp.com/nope' });
    expect(result.missing).toContain('BASECAMP_LINES_URL');
  });
});

describe('the ROUTES document', () => {
  const routes = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      routes: [{ repo: 'your-org/your-repo', branches: ['main'], ...extra }],
      fallthrough: 'ignore',
    });

  it('parses a valid document', () => {
    const config = pass(base({ ROUTES: routes() })).config;
    expect(config.ROUTES?.routes).toHaveLength(1);
    expect(config.ROUTES?.fallthrough).toBe('ignore');
  });

  it('rejects an unknown key inside a route', () => {
    const source = base({
      ROUTES: JSON.stringify({ routes: [{ repo: 'a/b', chat_id: '7654321' }] }),
    });
    const result = fail(source);
    expect(formatProblems(result.problems)).toContain('ROUTES[0]');
  });

  it('reports a route-level problem and a cross-field one in the same run', () => {
    const source = base({
      ROUTES: JSON.stringify({
        routes: [
          { repo: 'c/d', target: { bucketId: 2345678 } },
          { repo: 'e/f', githubTokenEnv: 'GITHUB_TOKEN_OTHERORG' },
        ],
      }),
    });
    const text = formatProblems(fail(source).problems);
    expect(text).toContain('ROUTES[0].target.bucketId');
    expect(text).toContain('GITHUB_TOKEN_OTHERORG');
  });

  it('registers a route chatbotKeyEnv value with the redactor', () => {
    const key = 'infra-room-key-aaaaaaaa';
    pass(
      base({
        BASECAMP_CHATBOT_KEY_INFRA: key,
        ROUTES: JSON.stringify({
          routes: [{ repo: 'a/b', target: { chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY_INFRA' } }],
        }),
      }),
    );
    expect(redactText(key)).toBe('***');
  });

  it('rejects a published literal in an inline route chatbotKey', () => {
    const result = fail(
      base({
        ROUTES: JSON.stringify({
          routes: [{ repo: 'a/b', target: { chatbotKey: 'PLACEHOLDERKEY0123456789' } }],
        }),
      }),
    );
    expect(formatProblems(result.problems)).toContain('PLACEHOLDERKEY0123456789');
  });

  it('accepts BASECAMP_CHATBOT_KEY_TEAM and rejects GITHUB_TOKEN as chatbotKeyEnv', () => {
    pass(
      base({
        BASECAMP_CHATBOT_KEY_TEAM: 'team-room-key-aaaaaaaa',
        ROUTES: JSON.stringify({
          routes: [{ repo: 'a/b', target: { chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY_TEAM' } }],
        }),
      }),
    );
    const result = fail(
      base({
        ROUTES: JSON.stringify({
          routes: [{ repo: 'a/b', target: { chatbotKeyEnv: 'GITHUB_TOKEN' } }],
        }),
      }),
    );
    expect(formatProblems(result.problems)).toContain('BASECAMP_CHATBOT_KEY or BASECAMP_CHATBOT_KEY_<SUFFIX>');
  });

  it('requires githubTokenEnv when githubApiBase points at a different host', () => {
    const result = fail(
      base({
        ROUTES: JSON.stringify({
          routes: [{ repo: 'other-org/**', githubApiBase: 'https://ghe.example.com/api/v3' }],
        }),
      }),
    );
    expect(formatProblems(result.problems)).toContain('ROUTES[0].githubApiBase');
    expect(formatProblems(result.problems)).toContain('ghe.example.com');
  });

  it('allows a different githubApiBase when githubTokenEnv is set', () => {
    pass(
      base({
        GITHUB_TOKEN_OTHERORG: 'ghp_0123456789abcdefghij',
        ROUTES: JSON.stringify({
          routes: [
            {
              repo: 'other-org/**',
              githubApiBase: 'https://ghe.example.com/api/v3',
              githubTokenEnv: 'GITHUB_TOKEN_OTHERORG',
            },
          ],
        }),
      }),
    );
  });

  it('rejects a numeric id that was written as a number', () => {
    const source = base({
      ROUTES: JSON.stringify({ routes: [{ repo: 'a/b', target: { bucketId: 2345678 } }] }),
    });
    expect(formatProblems(fail(source).problems)).toContain('ROUTES[0].target.bucketId: expected a numeric string, received a number.');
  });

  it('fails when githubTokenEnv names a variable that is not set', () => {
    const result = fail(base({ ROUTES: routes({ githubTokenEnv: 'GITHUB_TOKEN_OTHERORG' }) }));
    expect(result.missing).toContain('GITHUB_TOKEN_OTHERORG');
    expect(formatProblems(result.problems)).toContain('githubTokenEnv');
  });

  it('fails when webhookSecretEnv names a variable that is not set', () => {
    const result = fail(base({ ROUTES: routes({ webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_OTHERORG' }) }));
    expect(result.missing).toContain('GITHUB_WEBHOOK_SECRET_OTHERORG');
  });

  it('fails when a target chatbotKeyEnv names a variable that is not set', () => {
    const result = fail(base({ ROUTES: routes({ target: { chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY_INFRA' } }) }));
    expect(result.missing).toContain('BASECAMP_CHATBOT_KEY_INFRA');
  });

  it('accepts a route target that inherits the rest of the default target', () => {
    const result = pass(
      base({
        BASECAMP_CHATBOT_KEY_INFRA: 'infra-chatbot-key',
        ROUTES: routes({ target: { chatId: '1111111', chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY_INFRA' } }),
      }),
    );
    expect(result.config.ROUTES?.routes[0]?.target?.chatId).toBe('1111111');
  });

  it('resolves a complete target from the document alone', () => {
    const result = pass({
      GITHUB_WEBHOOK_SECRET: SECRET,
      BASECAMP_CHATBOT_KEY_INFRA: 'infra-chatbot-key',
      ROUTES: JSON.stringify({
        routes: [
          {
            repo: 'a/b',
            target: {
              accountId: '1234567',
              bucketId: '2345678',
              chatId: '7654321',
              chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY_INFRA',
            },
          },
        ],
      }),
    });
    expect(result.config.ROUTES?.routes).toHaveLength(1);
  });

  it('reports malformed JSON without a stack trace', () => {
    const result = fail(base({ ROUTES: '{not json' }));
    expect(result.missing).toContain('ROUTES');
    expect(formatProblems(result.problems)).not.toContain('    at ');
  });

  it('warns that an inline chatbotKey is a credential in a file', () => {
    const result = pass(base({ ROUTES: routes({ target: { chatbotKey: 'inline-key-value' } }) }));
    expect(result.warnings.map((w) => w.evt)).toContain('chatbotkey_inline_in_config');
  });
});

describe('precedence', () => {
  const document = JSON.stringify({ routes: [{ repo: 'from/file' }] });

  it('reads CONFIG_FILE when ROUTES is absent', () => {
    const withFile = loadConfig(base({ CONFIG_FILE: '/app/config.json' }), { readFile: () => document });
    if (!withFile.ok) throw new Error(formatProblems(withFile.problems));
    expect(withFile.config.ROUTES?.routes[0]?.repo).toBe('from/file');
  });

  it('lets ROUTES beat CONFIG_FILE and says so', () => {
    const result = loadConfig(
      base({ CONFIG_FILE: '/app/config.json', ROUTES: JSON.stringify({ routes: [{ repo: 'from/env' }] }) }),
      { readFile: () => document },
    );
    if (!result.ok) throw new Error(formatProblems(result.problems));
    expect(result.config.ROUTES?.routes[0]?.repo).toBe('from/env');
    expect(result.warnings.map((w) => w.evt)).toContain('config_file_shadowed');
  });

  it('lets an explicit value beat the built-in default', () => {
    expect(pass(base({ MAX_COMMITS_PER_PUSH: '5' })).config.MAX_COMMITS_PER_PUSH).toBe(5);
    expect(pass(base()).config.MAX_COMMITS_PER_PUSH).toBe(15);
  });

  it('says CONFIG_FILE is unavailable when the target has no filesystem', () => {
    expect(fail(base({ CONFIG_FILE: '/app/config.json' })).missing).toContain('CONFIG_FILE');
  });
});

describe('cross-field checks', () => {
  it('rejects an ENRICH_DEADLINE_MS below GITHUB_TIMEOUT_MS * 3 + 8000', () => {
    const result = fail(base({ ENRICH_DEADLINE_MS: '15000' }));
    expect(result.missing).toContain('ENRICH_DEADLINE_MS');
    expect(formatProblems(result.problems)).toContain('32000');
  });

  it('accepts a deadline exactly at the floor', () => {
    expect(pass(base({ ENRICH_DEADLINE_MS: '32000' })).config.ENRICH_DEADLINE_MS).toBe(32_000);
  });

  it('rejects REQUIRE_LINE_STATS when FETCH_LINE_STATS resolves to off', () => {
    expect(fail(base({ REQUIRE_LINE_STATS: 'true' })).missing).toContain('REQUIRE_LINE_STATS');
    expect(fail(base({ REQUIRE_LINE_STATS: 'true', FETCH_LINE_STATS: 'off' })).missing).toContain(
      'REQUIRE_LINE_STATS',
    );
  });

  it('accepts REQUIRE_LINE_STATS when a token makes auto resolve to on', () => {
    expect(pass(base({ REQUIRE_LINE_STATS: 'true', GITHUB_TOKEN: 'ghp_token' })).config.REQUIRE_LINE_STATS).toBe(
      true,
    );
  });

  it('accepts a chatbotKeyEnv naming BASECAMP_CHATBOT_KEY when the key came from the lines URL', () => {
    const result = pass({
      GITHUB_WEBHOOK_SECRET: SECRET,
      BASECAMP_LINES_URL:
        'https://3.basecampapi.com/1234567/integrations/EXAMPLEKEY0123456789ABCD/buckets/2345678/chats/7654321/lines.json',
      ROUTES: JSON.stringify({
        defaults: { target: { chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY' } },
        routes: [{ repo: 'a/b' }],
      }),
    });
    expect(result.config.BASECAMP_CHATBOT_KEY).toBe('EXAMPLEKEY0123456789ABCD');
  });

  it('rejects an http GITHUB_WEB_ORIGIN, the sole safeUrl allowlist', () => {
    expect(fail(base({ GITHUB_WEB_ORIGIN: 'http://ghe.example.com' })).missing).toContain('GITHUB_WEB_ORIGIN');
    expect(pass(base({ BASECAMP_API_BASE: 'http://127.0.0.1:9999' })).config.BASECAMP_API_BASE).toBe(
      'http://127.0.0.1:9999',
    );
  });

  it('rejects a drain budget shorter than one Basecamp POST', () => {
    expect(fail(base({ SHUTDOWN_DRAIN_MS: '2000' })).missing).toContain('SHUTDOWN_DRAIN_MS');
    expect(pass(base({ SHUTDOWN_DRAIN_MS: '0' })).config.SHUTDOWN_DRAIN_MS).toBe(0);
  });
});

describe('getConfig', () => {
  it('memoizes on the source object, returning the identical reference', () => {
    const source = base();
    const first = getConfig(source);
    expect(getConfig(source)).toBe(first);
    expect(tryGetConfig(source).ok).toBe(true);
  });

  it('lets /healthz reuse a boot that had the Node CONFIG_FILE reader', () => {
    const source = base({ CONFIG_FILE: '/app/config.json' });
    const boot = tryGetConfig(source, { readFile: () => JSON.stringify({ routes: [{ repo: 'a/b' }] }) });
    expect(boot.ok).toBe(true);
    expect(healthz(source).code).toBe(200);
  });

  it('throws a printable list rather than a stack-shaped message', () => {
    expect(() => getConfig({ ...base(), GITHUB_WEBHOOK_SECRET: undefined })).toThrow(
      /configuration is invalid/,
    );
  });
});

describe('the config_loaded summary', () => {
  it('redacts the chatbot key and carries the 7.2 fields', () => {
    const summary = pass(base({ GITHUB_TOKEN: 'ghp_token' })).summary;
    expect(summary).toMatchObject({
      routes: 0,
      fallthrough: 'ignore',
      defaultTarget: { accountId: '1234567', bucketId: '2345678', chatId: '7654321', chatbotKey: '***' },
      branches: ['**'],
      tags: [],
      lineStats: 'on',
      tokens: ['GITHUB_TOKEN'],
      maxCommitsPerPush: 15,
      contentMaxBytes: 16_384,
    });
    expect(JSON.stringify(summary)).not.toContain('chatbot-key-value');
  });

  it('proves the webhook secret was seen by its length, never by its value', () => {
    const summary = pass(base()).summary;
    expect(summary['webhookSecret']).toBe(`set (${SECRET.length} chars)`);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(JSON.stringify(summary)).not.toContain(SECRET.slice(0, 8));
  });

  it('counts only the tokens a route resolves, so auto matches the boot check', () => {
    const summary = pass(base({ GITHUB_TOKEN_OLD: 'ghp_unreferenced' })).summary;
    expect(summary['tokens']).toEqual([]);
    expect(summary['lineStats']).toBe('off');
  });

  it('rejects GITHUB_TOKEN with whitespace or control characters', () => {
    const result = fail(base({ GITHUB_TOKEN: 'ghp_abc\ndef' }));
    const text = formatProblems(result.problems);
    expect(text).toContain('GITHUB_TOKEN');
    expect(text).toContain('must not contain whitespace or control characters.');
  });

  it('rejects GITHUB_API_BASE without https except on loopback', () => {
    const result = fail(base({ GITHUB_API_BASE: 'http://github.example.com/' }));
    expect(formatProblems(result.problems)).toContain('must use the https scheme.');
  });

  it('allows http://127.0.0.1 for BASECAMP_API_BASE and rejects embedded credentials', () => {
    expect(pass(base({ BASECAMP_API_BASE: 'http://127.0.0.1:9999' })).config.BASECAMP_API_BASE).toBe(
      'http://127.0.0.1:9999',
    );
    const result = fail(base({ GITHUB_API_BASE: 'https://user:pass@example.com/' }));
    expect(formatProblems(result.problems)).toContain('must not contain credentials.');
  });

  it('rejects a glob pattern with more than two "**" segments', () => {
    const result = fail(base({ BRANCHES: 'release/**/**/**/*' }));
    expect(formatProblems(result.problems)).toContain('must not contain more than 2 "**" segments.');
  });

  it('warns once when REPO_ALLOWLIST accepts any signed repo', () => {
    expect(pass(base()).warnings.map((w) => w.evt)).toContain('repo_allowlist_open');
    expect(pass(base({ REPO_ALLOWLIST: 'your-org/*' })).warnings.map((w) => w.evt)).not.toContain(
      'repo_allowlist_open',
    );
  });
});
