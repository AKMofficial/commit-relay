import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../src/config/env.ts';
import { PUBLISHED_SECRET_LITERALS, routesDocument } from '../src/config/schema.ts';
import { loadConfig } from '../src/config/load.ts';

/** Node-only by naming convention: the workers project excludes *.node.test.ts
 *  because Workers has no filesystem to read the example files from. */
function dotenvKeys(path: string): string[] {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.slice(0, line.indexOf('=')));
}

function dotenvValue(path: string, key: string): string {
  const line = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  return line === undefined ? '' : line.slice(key.length + 1).trim();
}

describe.each(['.env.example', '.dev.vars.example'])('%s', (path) => {
  it('carries exactly the schema keys, once each', () => {
    const keys = dotenvKeys(path);
    expect([...keys].sort()).toEqual([...CONFIG_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ships a webhook secret the loader refuses', () => {
    const literal = dotenvValue(path, 'GITHUB_WEBHOOK_SECRET');
    expect(PUBLISHED_SECRET_LITERALS).toContain(literal);
    const result = loadConfig({
      GITHUB_WEBHOOK_SECRET: literal,
      BASECAMP_ACCOUNT_ID: '1234567',
      BASECAMP_CHATBOT_KEY: 'chatbot-key-value',
      BASECAMP_BUCKET_ID: '2345678',
      BASECAMP_CHAT_ID: '7654321',
    });
    expect(result.ok).toBe(false);
  });
});

describe('config.example.json', () => {
  it('validates against the routes schema', () => {
    const text = readFileSync(new URL('../config.example.json', import.meta.url), 'utf8');
    const parsed = routesDocument.safeParse(JSON.parse(text));
    expect(parsed.success).toBe(true);
  });

  it('names a variable for every chatbot key and never inlines one', () => {
    const text = readFileSync(new URL('../config.example.json', import.meta.url), 'utf8');
    expect(text).toContain('chatbotKeyEnv');
    expect(text).not.toMatch(/"chatbotKey"\s*:/);
  });
});

describe('README.md', () => {
  it('documents exactly the schema keys in its Configuration table', () => {
    const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const start = text.indexOf('\n## Configuration\n');
    const end = text.indexOf('\n### ', start);
    const table = text.slice(start, end);
    const documented = [...table.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
    expect([...documented].sort()).toEqual([...CONFIG_KEYS].sort());
    expect(new Set(documented).size).toBe(documented.length);
  });
});
