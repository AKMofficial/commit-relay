import { describe, expect, it } from 'vitest';
import type { LogFn } from '../obs/log.ts';
import { clipCodePoints } from '../render/truncate.ts';
import {
  COMMITS_ARRAY_CAP,
  parsePullRequest,
  parsePullRequestReview,
  parsePush,
  type ParseResult,
  type PullRequestParseResult,
} from './parse.ts';
import unknownFieldsRaw from '../../tests/fixtures/push.unknown-fields.json?raw';
import injectionRaw from '../../tests/fixtures/push.injection.json?raw';
import prMergedRaw from '../../tests/fixtures/pr.merged.json?raw';
import prClosedRaw from '../../tests/fixtures/pr.closed.json?raw';
import prDraftRaw from '../../tests/fixtures/pr.draft.json?raw';
import prInjectionRaw from '../../tests/fixtures/pr.injection.json?raw';
import reviewApprovedRaw from '../../tests/fixtures/review.approved.json?raw';

const LIMITS = { commitBodyMaxChars: 2000 };

/** The characters sanitizeText strips (8.2). */
const HOSTILE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

interface Line {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function run(raw: unknown, limits = LIMITS): { result: ParseResult; lines: Line[] } {
  const lines: Line[] = [];
  const log: LogFn = (level, event, fields) => {
    lines.push({ level, event, fields });
  };
  return { result: parsePush(raw, limits, log), lines };
}

function ok(result: ParseResult) {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result.event;
}

function okPr(result: PullRequestParseResult) {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result.event;
}

function runPr(
  raw: unknown,
  options: { review?: boolean; limits?: typeof LIMITS } = {},
): { result: PullRequestParseResult; lines: Line[] } {
  const { review = false, limits = LIMITS } = options;
  const lines: Line[] = [];
  const log: LogFn = (level, event, fields) => {
    lines.push({ level, event, fields });
  };
  const parse = review ? parsePullRequestReview : parsePullRequest;
  return { result: parse(raw, limits, log), lines };
}

const commit = (over: Record<string, unknown> = {}) => ({
  id: 'a'.repeat(40),
  message: 'Add a thing',
  url: `https://github.com/your-org/your-repo/commit/${'a'.repeat(40)}`,
  distinct: true,
  author: { name: 'Jane Doe', email: 'jane@example.com', username: 'jane-doe' },
  added: ['a.ts'],
  removed: [],
  modified: ['b.ts', 'c.ts'],
  ...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main',
  before: '1'.repeat(40),
  after: '2'.repeat(40),
  created: false,
  deleted: false,
  forced: false,
  compare: 'https://github.com/your-org/your-repo/compare/1...2',
  repository: {
    full_name: 'your-org/your-repo',
    name: 'your-repo',
    html_url: 'https://github.com/your-org/your-repo',
    owner: { login: 'your-org' },
  },
  sender: { login: 'jane-doe', type: 'User' },
  commits: [commit()],
  ...over,
});

describe('parsePush', () => {
  it('normalizes the 24 consumed paths', () => {
    const event = ok(run(payload()).result);
    expect(event.repoFullName).toBe('your-org/your-repo');
    expect(event.repoOwner).toBe('your-org');
    expect(event.repoName).toBe('your-repo');
    expect(event.senderType).toBe('User');
    expect(event.commits[0]).toMatchObject({
      id: 'a'.repeat(40),
      distinct: true,
      authorUsername: 'jane-doe',
      fileCount: 3,
    });
  });

  it('leaves authorUsername null when GitHub could not map the email', () => {
    const absent = payload({
      commits: [commit({ author: { name: 'Sam Lee', email: 'sam@example.com' } })],
    });
    expect(ok(run(absent).result).commits[0]?.authorUsername).toBe(null);
    const explicitNull = payload({
      commits: [commit({ author: { name: 'Sam Lee', email: 'sam@example.com', username: null } })],
    });
    expect(ok(run(explicitNull).result).commits[0]?.authorUsername).toBe(null);
  });

  it('processes a payload carrying unknown top-level and per-commit keys', () => {
    const raw = JSON.parse(unknownFieldsRaw) as Record<string, unknown>;
    expect(Object.keys(raw).filter((k) => k.startsWith('future_'))).toHaveLength(10);
    const commits = raw['commits'] as Array<Record<string, unknown>>;
    expect(Object.keys(commits[0] as object).filter((k) => k.startsWith('future_'))).toHaveLength(5);
    const event = ok(run(raw).result);
    expect(event.commits).toHaveLength(2);
  });

  it('rejects a hostile repository.full_name outright, before any renderer sees it', () => {
    const raw = JSON.parse(injectionRaw) as { repository: Record<string, unknown> };
    const hostile = {
      ...raw,
      repository: { ...raw.repository, full_name: 'your-org/<b>repo</b>' },
    };
    const result = run(hostile).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path.startsWith('repository'))).toBe(true);
  });

  it('sanitizes every payload-derived string of the injection fixture', () => {
    const event = ok(run(JSON.parse(injectionRaw)).result);
    const strings = [
      event.ref,
      event.senderLogin,
      ...event.commits.flatMap((c) => [c.message, c.authorName, c.authorEmail]),
    ];
    expect(strings.length).toBeGreaterThan(3);
    for (const value of strings) {
      expect(value).not.toMatch(HOSTILE);
      expect(value).not.toContain('\r');
    }
  });

  it('clips the message to COMMIT_BODY_MAX_CHARS code points without splitting a surrogate', () => {
    const astral = '\u{1D49C}'.repeat(50);
    const raw = payload({ commits: [commit({ message: astral })] });
    const message = ok(run(raw, { commitBodyMaxChars: 10 }).result).commits[0]?.message ?? '';
    expect(message).toBe(`${'\u{1D49C}'.repeat(10)} \u2026`);
    expect(message).not.toContain('�');
    expect(ok(run(payload()).result).commits[0]?.message).toBe('Add a thing');
  });

  it('clips on a whitespace boundary and marks the cut, the same clipCodePoints the renderer uses', () => {
    const long = `${'word '.repeat(600)}tail`;
    const raw = payload({ commits: [commit({ message: long })] });
    const message = ok(run(raw, { commitBodyMaxChars: 2000 }).result).commits[0]?.message ?? '';
    expect(Array.from(long).length).toBeGreaterThan(2000);
    expect(message.endsWith(' \u2026')).toBe(true);
    expect(message.slice(0, -2)).toBe(clipCodePoints(long, 2000).slice(0, -2));
    expect(message.replace(/ \u2026$/, '')).not.toMatch(/\s$/);
  });

  it('rejects a malformed full_name and a malformed commit id', () => {
    for (const fullName of ['no-slash', '../etc', 'your-org/..', 'your-org/a/b']) {
      const raw = payload({ repository: { ...payload().repository, full_name: fullName } });
      expect(run(raw).result.ok).toBe(false);
    }
    const bad = run(payload({ commits: [commit({ id: 'A'.repeat(40) })] })).result;
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toBe('commits[0].id');
    expect(run(payload({ commits: [commit({ id: 'abc' })] })).result.ok).toBe(false);
  });

  it('reports a shape violation as issues rather than throwing', () => {
    const result = run({ ref: 'refs/heads/main' }).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it('warns when owner.login disagrees with full_name, and full_name wins', () => {
    const raw = payload({ repository: { ...payload().repository, owner: { login: 'other-org' } } });
    const { result, lines } = run(raw);
    expect(ok(result).repoOwner).toBe('your-org');
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'repo_name_mismatch' }),
    );
    expect(run(payload()).lines.some((l) => l.event === 'repo_name_mismatch')).toBe(false);
  });

  it('warns payload_possibly_truncated at the 2048-entry cap', () => {
    const commits = Array.from({ length: COMMITS_ARRAY_CAP }, (_, i) =>
      commit({ id: i.toString(16).padStart(40, '0') }),
    );
    const { lines } = run(payload({ commits }));
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'payload_possibly_truncated' }),
    );
    expect(run(payload()).lines.some((l) => l.event === 'payload_possibly_truncated')).toBe(false);
  });

  it('caps a 10,000-character author name to 512 UTF-16 units', () => {
    const longName = 'n'.repeat(10_000);
    const event = ok(run(payload({ commits: [commit({ author: { name: longName, email: 'j@example.com' } })] })).result);
    expect(event.commits[0]?.authorName).toHaveLength(512);
  });

  it('rejects 2049 commits', () => {
    const commits = Array.from({ length: COMMITS_ARRAY_CAP + 1 }, (_, i) =>
      commit({ id: i.toString(16).padStart(40, '0') }),
    );
    expect(run(payload({ commits })).result.ok).toBe(false);
  });

  it('rejects a commit with more than 10,000 added paths', () => {
    const added = Array.from({ length: 10_001 }, (_, i) => `file-${i}.ts`);
    expect(run(payload({ commits: [commit({ added })] })).result.ok).toBe(false);
  });

  it('rejects an added array of numbers without throwing', () => {
    const raw = payload({ commits: [commit({ added: Array.from({ length: 300_000 }, (_, i) => i) })] });
    expect(() => run(raw).result.ok).not.toThrow();
    expect(run(raw).result.ok).toBe(false);
  });

  it('clips every payload field on code-point boundaries for astral input', () => {
    const astral = '𝒳';
    const zwj = '\u{1F468}\u{200D}\u{1F469}';
    for (const limit of [1, 2, 3, 5, 10, 50, 512]) {
      for (const unit of [astral, zwj]) {
        const text = unit.repeat(20);
        const event = ok(
          run(
            payload({
              ref: `refs/heads/${text}`,
              compare: `https://github.com/your-org/your-repo/compare/${text.slice(0, 40)}`,
              commits: [
                commit({
                  message: text,
                  url: `https://github.com/your-org/your-repo/commit/${'a'.repeat(40)}`,
                  author: { name: text, email: 'j@example.com' },
                }),
              ],
            }),
            { commitBodyMaxChars: limit },
          ).result,
        );
        expect(event.ref.isWellFormed()).toBe(true);
        expect(event.compare.isWellFormed()).toBe(true);
        expect(event.commits[0]?.message.isWellFormed()).toBe(true);
        expect(event.commits[0]?.url.isWellFormed()).toBe(true);
        expect(event.commits[0]?.authorName.isWellFormed()).toBe(true);
      }
    }
  });
});

describe('parsePullRequest', () => {
  it('normalizes a merged pull request with line counts and no review fields', () => {
    const event = okPr(runPr(JSON.parse(prMergedRaw)).result);
    expect(event.merged).toBe(true);
    expect(event.draft).toBe(false);
    expect(event.title).toBe('Add OAuth login flow');
    expect(event.headRef).toBe('feat/login');
    expect(event.baseRef).toBe('main');
    expect(event.author).toBe('jane-doe');
    expect(event.number).toBe(42);
    expect(event.fileCount).toBe(7);
    expect(event.additions).toBe(180);
    expect(event.deletions).toBe(24);
    expect(event).not.toHaveProperty('reviewState');
    expect(event).not.toHaveProperty('reviewId');
  });

  it('returns merged false on a closed pull request and draft true on a draft', () => {
    expect(okPr(runPr(JSON.parse(prClosedRaw)).result).merged).toBe(false);
    expect(okPr(runPr(JSON.parse(prDraftRaw)).result).draft).toBe(true);
  });

  it('clips a title longer than commitBodyMaxChars without splitting a 4-byte emoji', () => {
    const emoji = '\u{1F600}';
    const title = `${emoji.repeat(9)}tail`;
    const merged = JSON.parse(prMergedRaw) as { pull_request: { title: string } };
    const raw = {
      ...merged,
      pull_request: { ...merged.pull_request, title },
    };
    const clipped = okPr(runPr(raw, { limits: { commitBodyMaxChars: 10 } }).result).title;
    expect(clipped).toBe(`${emoji.repeat(9)}t …`);
  });

  it('sanitizes a C0 control character but preserves a script tag as text', () => {
    const raw = JSON.parse(prInjectionRaw) as {
      pull_request: { title: string; head: { ref: string }; user: { login: string } };
    };
    raw.pull_request.title = `\u0007${raw.pull_request.title}`;
    const event = okPr(runPr(raw).result);
    expect(event.title).not.toContain('\u0007');
    expect(event.title).toContain('<script>alert(1)</script>');
  });

  it('rejects a payload missing pull_request.head', () => {
    const raw = JSON.parse(prMergedRaw) as { pull_request: Record<string, unknown> };
    delete raw.pull_request['head'];
    const result = runPr(raw).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path.startsWith('pull_request.head'))).toBe(true);
  });

  it('rejects a repository.full_name that is not owner/name', () => {
    const raw = JSON.parse(prMergedRaw) as { repository: { full_name: string } };
    raw.repository.full_name = 'no-slash';
    const result = runPr(raw).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === 'repository.full_name')).toBe(true);
  });

  it('warns when owner.login disagrees with full_name, and full_name wins', () => {
    const raw = JSON.parse(prMergedRaw) as {
      repository: { owner: { login: string }; full_name: string; name: string };
    };
    raw.repository.owner.login = 'other-org';
    const { result, lines } = runPr(raw);
    expect(okPr(result).repoFullName).toBe('your-org/your-repo');
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'repo_name_mismatch' }),
    );
  });

  it('reports a shape violation as issues rather than throwing', () => {
    for (const raw of [null, 'not an object']) {
      const result = runPr(raw).result;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('accepts an empty title and zero line counts', () => {
    const raw = JSON.parse(prMergedRaw) as {
      pull_request: {
        title: string;
        changed_files: number;
        additions: number;
        deletions: number;
      };
    };
    raw.pull_request.title = '';
    raw.pull_request.changed_files = 0;
    raw.pull_request.additions = 0;
    raw.pull_request.deletions = 0;
    const event = okPr(runPr(raw).result);
    expect(event.title).toBe('');
    expect(event.fileCount).toBe(0);
    expect(event.additions).toBe(0);
    expect(event.deletions).toBe(0);
  });

  it('preserves a base branch name containing a glob metacharacter literally', () => {
    const raw = JSON.parse(prMergedRaw) as { pull_request: { base: { ref: string } } };
    raw.pull_request.base.ref = 'release/*';
    expect(okPr(runPr(raw).result).baseRef).toBe('release/*');
  });
});

describe('parsePullRequestReview', () => {
  it('returns reviewState, reviewId, the review htmlUrl, and null line counts', () => {
    const payload = JSON.parse(reviewApprovedRaw) as { review: { html_url: string } };
    const event = okPr(runPr(JSON.parse(reviewApprovedRaw), { review: true }).result);
    expect(event.reviewState).toBe('approved');
    expect(event.author).toBe('sam-lee');
    expect(typeof event.reviewId).toBe('number');
    expect(event.htmlUrl).toBe(payload.review.html_url);
    expect(event.fileCount).toBe(null);
    expect(event.additions).toBe(null);
    expect(event.deletions).toBe(null);
  });
});
