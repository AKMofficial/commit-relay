import { describe, expect, it } from 'vitest';

import wranglerConfig from '../wrangler.jsonc?raw';

/** The five enforced source rules of 15.1, as greps. Sources come through Vite's
 *  `?raw` glob, not `fs`, so both pools run it; `workerd` has no fs (15.3). */

const RAW = import.meta.glob('/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface Source {
  path: string;
  text: string;
  /** Comments removed, string and template contents intact. */
  withoutComments: string;
  /** Comments removed and every string body blanked: identifiers only. */
  codeOnly: string;
  /** Every template literal, with the expressions it interpolates. */
  templates: Template[];
}

interface Template {
  literal: string;
  expressions: string[];
}

interface Scan {
  withoutComments: string;
  codeOnly: string;
  templates: Template[];
}

/** Deliberately small: a full parser would be a second implementation of
 *  TypeScript, and every check below is a lexical one. */
function scan(text: string): Scan {
  let withoutComments = '';
  let codeOnly = '';
  const templates: Template[] = [];

  let i = 0;
  const n = text.length;

  const emit = (chunk: string, isCode: boolean): void => {
    withoutComments += chunk;
    codeOnly += isCode ? chunk : ' '.repeat(chunk.length);
  };

  while (i < n) {
    const two = text.slice(i, i + 2);

    if (two === '//') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    const ch = text[i] as string;

    if (ch === "'" || ch === '"') {
      const start = i;
      i += 1;
      while (i < n && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      emit(text.slice(start, Math.min(i, n)), false);
      continue;
    }

    if (ch === '`') {
      const start = i;
      i += 1;
      const expressions: string[] = [];
      let expression: string | null = null;
      let depth = 0;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (expression === null && text.slice(i, i + 2) === '${') {
          expression = '';
          depth = 1;
          i += 2;
          continue;
        }
        if (expression !== null) {
          const c = text[i] as string;
          if (c === '{') depth += 1;
          if (c === '}') {
            depth -= 1;
            if (depth === 0) {
              expressions.push(expression.trim());
              expression = null;
              i += 1;
              continue;
            }
          }
          expression += c;
          i += 1;
          continue;
        }
        if (text[i] === '`') break;
        i += 1;
      }
      i += 1;
      const literal = text.slice(start, Math.min(i, n));
      templates.push({ literal, expressions });
      emit(literal, false);
      continue;
    }

    emit(ch, true);
    i += 1;
  }

  return { withoutComments, codeOnly, templates };
}

const SOURCES: Source[] = Object.entries(RAW)
  .filter(([path]) => !path.endsWith('.test.ts'))
  .map(([path, text]) => ({ path, text, ...scan(text) }))
  .toSorted((a, b) => a.path.localeCompare(b.path));

function source(path: string): Source {
  const found = SOURCES.find((file) => file.path === path);
  if (found === undefined) throw new Error(`no such source: ${path}`);
  return found;
}

/** Files whose code (comments and string bodies removed) matches. */
function filesWhereCode(pattern: RegExp): string[] {
  return SOURCES.filter((file) => pattern.test(file.codeOnly)).map((file) => file.path);
}

/** Files whose text with comments removed matches; strings still count. */
function filesWhereText(pattern: RegExp): string[] {
  return SOURCES.filter((file) => pattern.test(file.withoutComments)).map((file) => file.path);
}

function under(prefix: string): Source[] {
  return SOURCES.filter((file) => file.path.startsWith(prefix));
}

it('reads the whole of src/ through the ?raw glob under both pools', () => {
  expect(SOURCES.length).toBeGreaterThan(30);
  expect(SOURCES.map((file) => file.path)).toContain('/src/render/message.ts');
  expect(source('/src/runtime/deps.ts').text).toContain('export interface Deps');
});

describe('1. no equality comparison on a credential', () => {
  /** A presence check leaks nothing: the comparison is against a literal, not
   *  against a second value, so it cannot bail out on a matching prefix (11.1). */
  const PRESENCE = new Set(['undefined', 'null', "''", '""', '0']);
  const SENSITIVE = /(token|secret|hash|digest|signature)/i;
  const COMPARISON = /([A-Za-z0-9_$.[\]]+)\s*([!=]==)\s*([A-Za-z0-9_$.[\]]+)/g;

  it('compares no token, secret, hash, digest or signature with === or !==', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const match of file.codeOnly.matchAll(COMPARISON)) {
        const [, left, operator, right] = match as unknown as [string, string, string, string];
        const sensitive = SENSITIVE.test(left) || SENSITIVE.test(right);
        if (!sensitive) continue;
        if (PRESENCE.has(left) || PRESENCE.has(right)) continue;
        offenders.push(`${file.path}: ${left} ${operator} ${right}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('verifies signatures with crypto.subtle.verify and nothing else', () => {
    const hmac = source('/src/security/hmac.ts');
    expect(hmac.codeOnly).toContain('crypto.subtle.verify');
    expect(hmac.codeOnly).not.toContain('crypto.subtle.sign');
    expect(filesWhereText(/\bfrom 'node:crypto'/)).toEqual([]);
  });
});

describe('2. the Basecamp endpoint reaches no log, error or health response', () => {
  const HOST = /3\.basecampapi\.com/;

  it('names the Basecamp host in no log call and no thrown error', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const line of file.withoutComments.split('\n')) {
        if (!HOST.test(line)) continue;
        if (/\blog\(|\bthrow\b/.test(line)) offenders.push(`${file.path}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the health endpoints clear of it entirely', () => {
    expect(HOST.test(source('/src/http/health.ts').text)).toBe(false);
  });

  it('builds the lines URL in src/basecamp/client.ts and calls it nowhere else', () => {
    expect(filesWhereText(/\/integrations\/\$\{|\$\{[^}]*\}\/integrations\//)).toEqual([
      '/src/basecamp/client.ts',
    ]);
    expect(filesWhereCode(/\blinesUrl\(/)).toEqual(['/src/basecamp/client.ts']);
  });

  it('logs only the redacted form of the URL from the client', () => {
    const client = source('/src/basecamp/client.ts');
    // Log calls only: the `url: string` of an interface declares a type.
    for (const call of client.withoutComments.matchAll(/deps\.log\([\s\S]*?\);/g)) {
      for (const match of (call[0] as string).matchAll(/\burl:\s*([A-Za-z0-9_$.]+)/g)) {
        expect(match[1]).toBe('redactedUrl');
      }
    }
  });
});

describe('3. every value interpolated into HTML is escaped', () => {
  /** The allow-list, with the reason each entry is safe. Anything else is a
   *  failure: the check is not a blocklist of dangerous shapes (8.2, 11.1). */
  const ESCAPING_CALL = /^(escapeHtml|plain)\(/;
  /** `S.x` is a compile-time constant from src/render/strings.ts. */
  const STRING_TABLE = /^S\.[A-Za-z]+$/;
  /** Locals holding already-escaped HTML, by naming convention. */
  const ESCAPED_LOCAL = /^(?:[a-z][A-Za-z0-9]*)?(?:Html|html)$/;
  const ALLOWED_LOCALS = new Map<string, string>([
    ['label', 'always an S.* constant: pair() is called only with one'],
    ['authors', 'r.authors.map(plain).join(", "): every element passed plain()'],
    ['link', 'anchor(): either an escaped <a> or escaped plain text'],
    ['link.trim()', 'the same anchor() result, whitespace-trimmed'],
    ['changes', 'either the em-dash constant or a +N / -N pair of numbers'],
    ['files', 'either the em-dash constant or a number'],
    ['v.additions', 'a number from the GitHub stats response'],
    ['v.deletions', 'a number from the GitHub stats response'],
    ['v.fileCount', 'a number counted from the payload'],
    ['r.fileCount', 'a number counted from the payload'],
  ]);

  /** Only the literals that build markup: 8.2 orders truncation BEFORE escaping,
   *  so a literal with no tag in it is source text the caller escapes later. */
  const htmlTemplates = (file: Source): Template[] =>
    file.templates.filter((template) => template.literal.includes('<'));

  it('interpolates only escaped values inside src/render/', () => {
    const offenders: string[] = [];
    for (const file of under('/src/render/')) {
      for (const expression of htmlTemplates(file).flatMap((t) => t.expressions)) {
        if (ESCAPING_CALL.test(expression)) continue;
        if (STRING_TABLE.test(expression)) continue;
        if (ESCAPED_LOCAL.test(expression)) continue;
        if (ALLOWED_LOCALS.has(expression)) continue;
        offenders.push(`${file.path}: \${${expression}}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('routes every href through safeUrl', () => {
    const withHref = under('/src/render/').flatMap((file) =>
      file.templates.map((template) => template.literal).filter((literal) => literal.includes('href=')),
    );
    expect(withHref.length).toBeGreaterThan(0);
    for (const literal of withHref) {
      expect(literal).toMatch(/href="\$\{escapeHtml\(safe\)\}"/);
    }
    // `safe` is the return of safeUrl(), which is https-only and origin-checked.
    // anchor() is the single href-emitting helper every table shares.
    expect(source('/src/render/table.ts').codeOnly).toMatch(
      /const safe = safeUrl\(url, origin\)/,
    );
  });

  it('emits HTML tags from src/render/ only', () => {
    const emitters = filesWhereText(/<(?:table|tbody|tr|td|blockquote)[\s>]/);
    expect(emitters.length).toBeGreaterThan(0);
    // The markup primitives live in table.ts and the per-event builders beside
    // it; what the invariant forbids is any module outside src/render/ emitting
    // a tag of its own.
    for (const path of emitters) expect(path.startsWith('/src/render/')).toBe(true);
  });
});

describe('4. the request body is read exactly once, as bytes, before any parse', () => {
  const webhook = source('/src/http/webhook.ts');

  it('reads the body through one capped reader and parses those same bytes', () => {
    expect(webhook.codeOnly.match(/await readCapped\(request\.body,/g)).toHaveLength(1);
    expect(webhook.codeOnly).toContain('request.body');

    // The property, not one spelling of it: whatever JSON.parse receives has to
    // be the decode of `raw`, either inline, or through a local bound to it.
    const decodeOfRaw = /(?:const|let)\s+(\w+)\s*=\s*TEXT_DECODER\.decode\(raw\)/g;
    const decodedLocals = new Set(
      [...webhook.codeOnly.matchAll(decodeOfRaw)].map((match) => match[1]),
    );
    const parsedArguments = [...webhook.codeOnly.matchAll(/JSON\.parse\(([^)]*(?:\)[^)]*)*?)\)\s*;/g)]
      .map((match) => (match[1] ?? '').trim());
    expect(parsedArguments.length).toBeGreaterThan(0);
    for (const argument of parsedArguments) {
      expect(
        argument === 'TEXT_DECODER.decode(raw)' || decodedLocals.has(argument),
      ).toBe(true);
    }
  });

  it('never reaches for a parsed body helper anywhere in the HTTP layer', () => {
    for (const file of under('/src/http/')) {
      expect(file.codeOnly).not.toMatch(/c\.req\.(?:json|text|parseBody|arrayBuffer|blob)\(/);
    }
    expect(webhook.codeOnly).not.toMatch(/request\.(?:json|text|formData)\(/);
  });

  it('verifies before it parses', () => {
    const verifyAt = webhook.codeOnly.indexOf('await verify(');
    const parseAt = webhook.codeOnly.indexOf('JSON.parse(');
    expect(verifyAt).toBeGreaterThan(0);
    expect(parseAt).toBeGreaterThan(verifyAt);
  });
});

describe('5. the module boundaries', () => {
  it('imports hono in src/http/app.ts only, and @hono/node-server in src/server.ts only', () => {
    expect(filesWhereText(/from 'hono(?:\/[^']*)?'/)).toEqual(['/src/http/app.ts']);
    expect(filesWhereText(/from '@hono\/node-server'/)).toEqual(['/src/server.ts']);
  });

  it('keeps src/core/**, src/relay/** and src/render/** off every platform import', () => {
    for (const file of [...under('/src/core/'), ...under('/src/relay/'), ...under('/src/render/')]) {
      expect([file.path, /from '(?:node:|cloudflare:|hono)/.test(file.withoutComments)]).toEqual([
        file.path,
        false,
      ]);
    }
  });

  it('calls console.* from src/obs/log.ts only', () => {
    expect(filesWhereCode(/\bconsole\.[a-z]+\(/)).toEqual(['/src/obs/log.ts']);
  });

  it('calls relayPush and relayPullRequest from src/queue/consumer.ts only', () => {
    // Both names, or a new entry point would slip past a grep pinned to the old one.
    expect(filesWhereCode(/[^.\w]relay(?:Push|PullRequest)\(/)).toEqual([
      '/src/queue/consumer.ts',
      '/src/relay/pipeline.ts',
    ]);
    expect(filesWhereText(/from '\.\.\/relay\/pipeline\.ts'/)).toEqual(['/src/queue/consumer.ts']);
  });

  it('paces with await sleep(ms) and never a Date.now() delta', () => {
    for (const file of [...under('/src/basecamp/'), ...under('/src/queue/'), ...under('/src/relay/')]) {
      expect([file.path, /Date\.now\(/.test(file.codeOnly)]).toEqual([file.path, false]);
    }
    expect(source('/src/relay/poster.ts').codeOnly).toContain('await deps.sleep(');
  });

  it('fans out over no commit in the poster', () => {
    expect(source('/src/relay/poster.ts').codeOnly).not.toContain('Promise.all');
  });

  it('keeps src/security/hmac.ts free of every config import', () => {
    expect(source('/src/security/hmac.ts').withoutComments).not.toMatch(/from '\.\.\/config\//);
  });

  it('registers app.onError in src/http/app.ts', () => {
    expect(source('/src/http/app.ts').codeOnly).toContain('app.onError(');
  });
});

describe('6. nodejs_compat stays off in wrangler.jsonc', () => {
  it('does not list nodejs_compat in compatibility_flags', () => {
    const match = wranglerConfig.match(/"compatibility_flags"\s*:\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    const flagsBody = match?.[1] ?? '';
    expect(flagsBody.includes('"nodejs_compat"')).toBe(false);
  });
});
