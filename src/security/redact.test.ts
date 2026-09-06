import { afterEach, describe, expect, it } from 'vitest';
import { redactOutbound, redactText, registerSecrets } from './redact.ts';

const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa1111';
const KEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb2222';
const KEY_C = 'cccccccccccccccccccccccc3333';

afterEach(() => {
  registerSecrets([]);
});

describe('redactText', () => {
  it('masks the chatbot key inside a bare URL', () => {
    registerSecrets([KEY_A]);
    const url = `https://3.basecampapi.com/1234567/integrations/${KEY_A}/buckets/2345678/chats/7654321/lines.json`;
    const out = redactText(url);
    expect(out).not.toContain(KEY_A);
    expect(out).toContain('/integrations/***');
  });

  it('masks the key by shape even when it was never registered', () => {
    const url = 'https://3.basecampapi.com/1234567/integrations/never-registered-key/buckets/1/chats/2/lines.json';
    expect(redactText(url)).toContain('/integrations/***');
  });

  it('masks the key inside a nested Error.message', () => {
    registerSecrets([KEY_A]);
    const err = new Error(`POST failed for /integrations/${KEY_A}/buckets/2345678`);
    expect(redactText(err.message)).not.toContain(KEY_A);
  });

  it('masks the key along an Error.cause chain', () => {
    registerSecrets([KEY_A]);
    const root = new Error(`connect ECONNREFUSED while posting key ${KEY_A}`);
    const wrapped = new Error('basecamp post failed', { cause: root });
    const serialized = JSON.stringify({
      message: wrapped.message,
      cause: { message: (wrapped.cause as Error).message },
    });
    const out = redactText(serialized);
    expect(out).not.toContain(KEY_A);
    expect(out).toContain('***');
  });

  it('masks the key inside a JSON-serialized object, whatever the field is called', () => {
    registerSecrets([KEY_A]);
    const line = JSON.stringify({ evt: 'post_failed', totally_innocent_field: KEY_A });
    const out = redactText(line);
    expect(out).not.toContain(KEY_A);
    expect(out).toContain('"totally_innocent_field":"***"');
  });

  it('masks all three route chatbot keys when three are registered at once', () => {
    registerSecrets([KEY_A, KEY_B, KEY_C]);
    const line = JSON.stringify({ a: KEY_A, b: KEY_B, c: KEY_C });
    const out = redactText(line);
    for (const key of [KEY_A, KEY_B, KEY_C]) expect(out).not.toContain(key);
    expect(out).toBe('{"a":"***","b":"***","c":"***"}');
  });

  it('sorts longest-first so a short secret cannot leave a readable remainder', () => {
    const short = 'prefix-secret';
    const long = `${short}-with-a-longer-tail`;
    registerSecrets([short, long]);
    expect(redactText(`value=${long}`)).toBe('value=***');
    expect(redactText(`value=${short}`)).toBe('value=***');
  });

  it('ignores values under 8 characters, which would mask ordinary text', () => {
    registerSecrets(['abc']);
    expect(redactText('abc def')).toBe('abc def');
  });

  it('masks bearer tokens, GitHub token shapes, URL userinfo, and digests by shape', () => {
    const line = JSON.stringify({
      auth: 'Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      pat: 'github_pat_0123456789abcdefghijklmnop',
      url: 'https://user:pass@example.com/x',
      sig: 'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    const out = redactText(line);
    expect(out).toContain('Bearer ***');
    expect(out).not.toContain('github_pat_0123456789abcdefghijklmnop');
    expect(out).toContain('://***@');
    expect(out).toContain('sha256=***');
  });

  it('masks HTML-escaped and JSON-escaped variants of a registered secret', () => {
    const secret = 'hunter2&x"y';
    registerSecrets([secret]);
    expect(redactText('...hunter2&amp;x&quot;y...')).toBe('...***...');
    expect(redactText('..."hunter2&x\\"y"...')).toBe('..."***"...');
  });
});

// Each prose case below was an observed corruption under the log-tuned rules.
describe('redactOutbound', () => {
  it('leaves ordinary commit prose alone', () => {
    const cases = [
      'fix: refresh the token expiration check',
      'Refactor token validation in the auth middleware',
      'chore: document token rotation and token handling',
      'Bearer tokens are described in the README',
    ];
    for (const subject of cases) {
      expect(redactOutbound(subject)).toBe(subject);
    }
  });

  it('leaves a GitHub compare link intact', () => {
    const href =
      '<a href="https://github.com/your-org/your-repo/compare/abc1234...def5678">View the full comparison</a>';
    expect(redactOutbound(href)).toBe(href);
  });

  it('leaves an /integrations/ path on a non-Basecamp host alone', () => {
    // Kept off github.com so the de-branding gate's repository-slug rule stays happy.
    const href = '<a href="https://git.example.com/integrations/commit/abc1234">c</a>';
    expect(redactOutbound(href)).toBe(href);
    expect(redactOutbound('see /integrations/ in the docs')).toBe('see /integrations/ in the docs');
  });

  it('still masks a registered secret pasted into a commit message', () => {
    registerSecrets([KEY_A]);
    const body = `oops, pushed the key: ${KEY_A}`;
    const out = redactOutbound(body);
    expect(out).not.toContain(KEY_A);
    expect(out).toContain('***');
  });

  it('masks the chatbot key by position, but only on the Basecamp host', () => {
    const basecamp =
      'https://3.basecampapi.com/1234567/integrations/never-registered-key/buckets/1/chats/2/lines.json';
    expect(redactOutbound(basecamp)).toContain('/integrations/***');
    expect(redactOutbound(basecamp)).not.toContain('never-registered-key');
  });

  it('masks credential-shaped literals that carry no prose collision', () => {
    expect(redactOutbound('leaked ghp_' + 'a'.repeat(36))).toContain('***');
    expect(redactOutbound('leaked github_pat_' + 'b'.repeat(22))).toContain('***');
    expect(redactOutbound('sig sha256=' + 'f'.repeat(64))).toContain('sha256=***');
    expect(redactOutbound('https://user:pw@example.com/x')).toContain('://***@');
  });
});
