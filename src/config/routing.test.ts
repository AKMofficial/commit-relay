import { describe, expect, it } from 'vitest';
import { isRouteMatch, type ParsedRef, type RouteDecision, type RouteMatch } from '../core/types.ts';
import { getConfig, loadConfig, formatProblems } from './load.ts';
import { compileRoutes } from './routing.ts';

const SECRET = 'f3a91c07be24d85a6f0b1c72e94d3a58';
const KEY = 'chatbot-key-aaaaaaaa';

const BASE: Record<string, string> = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  BASECAMP_ACCOUNT_ID: '1234567',
  BASECAMP_CHATBOT_KEY: KEY,
  BASECAMP_BUCKET_ID: '2345678',
  BASECAMP_CHAT_ID: '7654321',
};

function build(env: Record<string, string> = {}) {
  const source = { ...BASE, ...env };
  return { routing: compileRoutes(getConfig(source), source), source };
}

const branch = (name: string): ParsedRef => ({ kind: 'branch', name });
const tag = (name: string): ParsedRef => ({ kind: 'tag', name });

function expectMatch(decision: RouteDecision): RouteMatch {
  if (!isRouteMatch(decision)) throw new Error(`expected a match, got ${decision.skipped}`);
  return decision;
}

describe('REPO_ALLOWLIST', () => {
  it('is evaluated before routing and matches case-insensitively', () => {
    const { routing } = build({ REPO_ALLOWLIST: 'your-org/*' });
    expect(expectMatch(routing.matchRoute('YOUR-ORG/your-repo', branch('main'))).matchedRoute).toBe(
      null,
    );
    const denied = routing.matchRoute('other-org/api', branch('main'));
    expect(denied).toMatchObject({ skipped: 'repo_not_allowed', patternsTried: ['your-org/*'] });
  });
});

describe('matchRoute', () => {
  const ROUTES = {
    defaults: {
      branches: ['main'],
      target: { accountId: '1234567', chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY', bucketId: '2345678', chatId: '7654321' },
    },
    routes: [
      { repo: 'your-org/your-repo', branches: ['main', 'release/*'] },
      {
        repo: 'your-org/infra-*',
        branches: ['**'],
        target: { bucketId: '9999999', chatId: '8888888', chatbotKeyEnv: 'BASECAMP_CHATBOT_KEY_INFRA' },
        skipMergeCommits: false,
        maxCommitsPerPush: 5,
      },
      {
        repo: 'other-org/**',
        branches: ['main'],
        tags: ['v*'],
        githubTokenEnv: 'GITHUB_TOKEN_OTHERORG',
        githubApiBase: 'https://ghes.example.com/api/v3',
        webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_OTHERORG',
      },
    ],
    fallthrough: 'ignore',
  };

  const env = {
    ROUTES: JSON.stringify(ROUTES),
    BASECAMP_CHATBOT_KEY_INFRA: 'infra-key-aaaaaaaa',
    GITHUB_TOKEN_OTHERORG: 'ghp_0123456789abcdefghij',
    GITHUB_WEBHOOK_SECRET_OTHERORG: 'a7c1e9d3b5f70826c4a1e9d3b5f70826',
  };

  it('evaluates routes top to bottom, first match wins', () => {
    const { routing } = build(env);
    expect(expectMatch(routing.matchRoute('your-org/your-repo', branch('main'))).matchedRoute).toBe(
      'your-org/your-repo',
    );
    expect(
      expectMatch(routing.matchRoute('your-org/infra-core', branch('anything/deep'))).matchedRoute,
    ).toBe('your-org/infra-*');
  });

  it('matches the repo glob case-insensitively', () => {
    const { routing } = build(env);
    expect(expectMatch(routing.matchRoute('YOUR-ORG/INFRA-CORE', branch('x'))).matchedRoute).toBe(
      'your-org/infra-*',
    );
  });

  it('shallow-merges the route target over defaults.target over the flat variables', () => {
    const { routing } = build(env);
    const inherited = expectMatch(routing.matchRoute('your-org/your-repo', branch('main')));
    expect(inherited.target).toMatchObject({
      accountId: '1234567',
      bucketId: '2345678',
      chatId: '7654321',
      chatbotKey: KEY,
    });
    const overridden = expectMatch(routing.matchRoute('your-org/infra-core', branch('x')));
    expect(overridden.target).toMatchObject({
      accountId: '1234567', // inherited from defaults.target
      bucketId: '9999999',
      chatId: '8888888',
      chatbotKey: 'infra-key-aaaaaaaa',
    });
  });

  it('resolves per-route githubTokenEnv, githubApiBase and webhookSecretEnv', () => {
    const { routing } = build(env);
    const other = expectMatch(routing.matchRoute('other-org/api', branch('main')));
    expect(other.target.githubToken).toBe('ghp_0123456789abcdefghij');
    expect(other.target.githubApiBase).toBe('https://ghes.example.com/api/v3');
    expect(other.webhookSecretEnv).toBe('GITHUB_WEBHOOK_SECRET_OTHERORG');
    const own = expectMatch(routing.matchRoute('your-org/your-repo', branch('main')));
    expect(own.webhookSecretEnv).toBeUndefined();
    expect(own.target.githubApiBase).toBe('https://api.github.com');
  });

  it('applies per-route overrides and falls back to the globals otherwise', () => {
    const { routing } = build(env);
    const infra = expectMatch(routing.matchRoute('your-org/infra-core', branch('x')));
    expect(infra.options.skipMergeCommits).toBe(false);
    expect(infra.options.maxCommitsPerPush).toBe(5);
    const own = expectMatch(routing.matchRoute('your-org/your-repo', branch('main')));
    expect(own.options).toEqual({
      skipMergeCommits: true,
      skipForcedPushes: false,
      skipNonDistinct: true,
      ignoreAuthors: [],
      maxCommitsPerPush: 15,
      prActions: ['opened', 'closed', 'reopened', 'ready_for_review'],
      prReviews: true,
      prSkipDrafts: true,
    });
  });

  it('drops an unmatched repo with no_route when fallthrough is ignore', () => {
    const { routing } = build(env);
    expect(routing.matchRoute('third-org/api', branch('main'))).toMatchObject({
      skipped: 'no_route',
      matchedRoute: null,
      patternsTried: ['your-org/your-repo', 'your-org/infra-*', 'other-org/**'],
    });
  });

  it('sends an unmatched repo to defaults when fallthrough is defaults', () => {
    const { routing } = build({
      ...env,
      ROUTES: JSON.stringify({ ...ROUTES, fallthrough: 'defaults' }),
    });
    const match = expectMatch(routing.matchRoute('third-org/api', branch('main')));
    expect(match.matchedRoute).toBe(null);
    expect(match.branches).toEqual(['main']);
    expect(routing.matchRoute('third-org/api', branch('feature/spike'))).toMatchObject({
      skipped: 'branch_not_allowed',
      patternsTried: ['main'],
    });
  });

  it('matches branches case-sensitively against the stripped name', () => {
    const { routing } = build(env);
    expect(isRouteMatch(routing.matchRoute('your-org/your-repo', branch('release/2.0')))).toBe(true);
    expect(routing.matchRoute('your-org/your-repo', branch('Main'))).toMatchObject({
      skipped: 'branch_not_allowed',
      matchedRoute: 'your-org/your-repo',
      patternsTried: ['main', 'release/*'],
    });
  });

  it('skips a tag with tags_disabled when the effective tag list is empty', () => {
    const { routing } = build(env);
    expect(routing.matchRoute('your-org/your-repo', tag('v0.1.0'))).toMatchObject({
      skipped: 'tags_disabled',
      matchedRoute: 'your-org/your-repo',
      patternsTried: [],
    });
  });

  it('matches a tag against the tag list only, never against branches', () => {
    const { routing } = build(env);
    expect(isRouteMatch(routing.matchRoute('other-org/api', tag('v0.1.0')))).toBe(true);
    expect(routing.matchRoute('other-org/api', tag('nightly'))).toMatchObject({
      skipped: 'tag_not_allowed',
      patternsTried: ['v*'],
    });
    expect(routing.matchRoute('other-org/api', tag('main'))).toMatchObject({
      skipped: 'tag_not_allowed',
    });
  });

  it('inherits the TAGS variable when no route or defaults list is given', () => {
    const { routing } = build({ TAGS: 'v*' });
    expect(isRouteMatch(routing.matchRoute('your-org/your-repo', tag('v0.1.0')))).toBe(true);
  });
});

describe('pull request route options', () => {
  it('overrides global prReviews, prActions, and prSkipDrafts on a matching route', () => {
    const { routing } = build({
      PR_ACTIONS: 'opened,closed,reopened,ready_for_review',
      PR_REVIEWS: 'true',
      PR_SKIP_DRAFTS: 'true',
      ROUTES: JSON.stringify({
        routes: [
          {
            repo: 'your-org/your-repo',
            prReviews: false,
            prActions: ['opened'],
            prSkipDrafts: false,
          },
        ],
      }),
    });
    const match = expectMatch(routing.matchRoute('your-org/your-repo', branch('main')));
    expect(match.options).toMatchObject({
      prReviews: false,
      prActions: ['opened'],
      prSkipDrafts: false,
    });
  });

  it('inherits global pull request knobs when a route omits them', () => {
    const { routing } = build({
      PR_ACTIONS: 'opened,closed',
      PR_REVIEWS: 'false',
      PR_SKIP_DRAFTS: 'false',
      ROUTES: JSON.stringify({ routes: [{ repo: 'your-org/your-repo' }] }),
    });
    const match = expectMatch(routing.matchRoute('your-org/your-repo', branch('main')));
    expect(match.options).toMatchObject({
      prActions: ['opened', 'closed'],
      prReviews: false,
      prSkipDrafts: false,
    });
  });
});

describe('defaults.prActions in the routes document', () => {
  it('rejects prActions under defaults because the schema is strict', () => {
    const source = {
      ...BASE,
      ROUTES: JSON.stringify({
        defaults: { prActions: ['opened'] },
        routes: [{ repo: 'your-org/your-repo' }],
      }),
    };
    const result = loadConfig(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(formatProblems(result.problems)).toContain('ROUTES.defaults');
    if (!result.ok) expect(formatProblems(result.problems)).toContain('prActions');
  });
});

describe('expectedSecretEnv', () => {
  const ROUTES = {
    routes: [
      { repo: 'your-org/*', webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_ORGA' },
      { repo: 'other-org/**', webhookSecretEnv: 'GITHUB_WEBHOOK_SECRET_OTHERORG' },
    ],
    fallthrough: 'ignore',
  };

  it('returns the route secret independently of branch filtering', () => {
    const { routing } = build({
      ROUTES: JSON.stringify(ROUTES),
      GITHUB_WEBHOOK_SECRET_ORGA: 'a'.repeat(32),
      GITHUB_WEBHOOK_SECRET_OTHERORG: 'b'.repeat(32),
    });
    expect(routing.expectedSecretEnv('your-org/your-repo')).toBe('GITHUB_WEBHOOK_SECRET_ORGA');
    expect(routing.expectedSecretEnv('unknown/repo')).toBeUndefined();
  });

  it('returns null when the matched route uses the global secret', () => {
    const { routing } = build({
      ROUTES: JSON.stringify({ routes: [{ repo: 'your-org/*' }], fallthrough: 'ignore' }),
    });
    expect(routing.expectedSecretEnv('your-org/your-repo')).toBeNull();
  });
});
