/** Every glob is compiled once, here, at boot (7.5, 7.6): no payload value is
 *  ever compiled into a matcher. */

import type {
  CompiledRouting,
  ParsedRef,
  RouteDecision,
  RouteMatch,
  RouteOptions,
} from '../core/types.ts';
import { readValue, type EnvSource } from './env.ts';
import { compileGlob, compileGlobs } from './glob.ts';
import type { Config, Route, Target } from './schema.ts';

type PartialTarget = Partial<Record<'accountId' | 'bucketId' | 'chatId' | 'chatbotKey', string>>;

type RepoResolution =
  | { kind: 'repo_not_allowed' }
  | { kind: 'no_route'; matchedRoute: string | null }
  | { kind: 'match'; match: RouteMatch };

/** The key is resolved to its value here, so no env-var name ever reaches
 *  ResolvedTarget and nothing downstream reads the environment. */
function targetLayer(source: EnvSource, t: Target | undefined): PartialTarget {
  if (t === undefined) return {};
  const chatbotKey =
    t.chatbotKey ?? (t.chatbotKeyEnv === undefined ? undefined : readValue(source, t.chatbotKeyEnv));
  return {
    ...(t.accountId === undefined ? {} : { accountId: t.accountId }),
    ...(t.bucketId === undefined ? {} : { bucketId: t.bucketId }),
    ...(t.chatId === undefined ? {} : { chatId: t.chatId }),
    ...(chatbotKey === undefined ? {} : { chatbotKey }),
  };
}

function isComplete(t: PartialTarget): t is Required<PartialTarget> {
  return Boolean(t.accountId && t.bucketId && t.chatId && t.chatbotKey);
}

export function compileRoutes(config: Config, source: EnvSource): CompiledRouting {
  const doc = config.ROUTES;

  // Evaluated before routing (7.5), and case-insensitively: GitHub repository
  // names are not case-sensitive.
  const allowlist = config.REPO_ALLOWLIST;
  const allowlistMatcher = compileGlobs(allowlist, { caseInsensitive: true });

  const flat = targetLayer(source, {
    accountId: config.BASECAMP_ACCOUNT_ID,
    bucketId: config.BASECAMP_BUCKET_ID,
    chatId: config.BASECAMP_CHAT_ID,
    chatbotKey: config.BASECAMP_CHATBOT_KEY,
  });
  const defaultTarget: PartialTarget = { ...flat, ...targetLayer(source, doc?.defaults?.target) };

  const defaultBranches = doc?.defaults?.branches ?? config.BRANCHES;
  const defaultTags = doc?.defaults?.tags ?? config.TAGS;

  const globalOptions: RouteOptions = {
    skipMergeCommits: config.SKIP_MERGE_COMMITS,
    skipForcedPushes: config.SKIP_FORCED_PUSHES,
    skipNonDistinct: config.SKIP_NON_DISTINCT,
    ignoreAuthors: config.IGNORE_AUTHORS,
    maxCommitsPerPush: config.MAX_COMMITS_PER_PUSH,
    prActions: config.PR_ACTIONS,
    prReviews: config.PR_REVIEWS,
    prSkipDrafts: config.PR_SKIP_DRAFTS,
  };

  const resolve = (route: Route | null): RouteMatch | null => {
    const merged: PartialTarget =
      route === null ? defaultTarget : { ...defaultTarget, ...targetLayer(source, route.target) };
    if (!isComplete(merged)) return null;

    const githubToken =
      route?.githubTokenEnv === undefined
        ? (config.GITHUB_TOKEN ?? null)
        : // No fallback to the global token: a typo must not silently defeat the
          // isolation this field exists to provide (7.5).
          (readValue(source, route.githubTokenEnv) ?? null);

    const branches = route?.branches ?? defaultBranches;
    const tags = route?.tags ?? defaultTags;
    const ignoreAuthors = route?.ignoreAuthors ?? globalOptions.ignoreAuthors;

    return {
      target: {
        accountId: merged.accountId,
        chatbotKey: merged.chatbotKey,
        bucketId: merged.bucketId,
        chatId: merged.chatId,
        apiBase: config.BASECAMP_API_BASE,
        githubToken,
        githubApiBase: route?.githubApiBase ?? config.GITHUB_API_BASE,
        webOrigin: config.GITHUB_WEB_ORIGIN,
      },
      options: {
        skipMergeCommits: route?.skipMergeCommits ?? globalOptions.skipMergeCommits,
        skipForcedPushes: route?.skipForcedPushes ?? globalOptions.skipForcedPushes,
        skipNonDistinct: route?.skipNonDistinct ?? globalOptions.skipNonDistinct,
        ignoreAuthors,
        maxCommitsPerPush: route?.maxCommitsPerPush ?? globalOptions.maxCommitsPerPush,
        prActions: route?.prActions ?? globalOptions.prActions,
        prReviews: route?.prReviews ?? globalOptions.prReviews,
        prSkipDrafts: route?.prSkipDrafts ?? globalOptions.prSkipDrafts,
      },
      branches,
      tags,
      matchedRoute: route?.repo ?? null,
      ...(route?.webhookSecretEnv === undefined ? {} : { webhookSecretEnv: route.webhookSecretEnv }),
      // Branch and tag globs are case-SENSITIVE: git refs are.
      branchMatcher: compileGlobs(branches),
      tagMatcher: compileGlobs(tags),
      // Logins and email addresses are not case-sensitive in practice.
      ignoreAuthorsMatcher: compileGlobs(ignoreAuthors, { caseInsensitive: true }),
    };
  };

  const compiled = (doc?.routes ?? []).map((route) => ({
    route,
    matcher: compileGlob(route.repo, { caseInsensitive: true }),
    resolved: resolve(route),
  }));
  // With no routes declared the flat BASECAMP_* target IS the whole config, so
  // `fallthrough` has nothing to arbitrate; it only governs a document with routes.
  const fallthrough = doc?.fallthrough ?? 'ignore';
  const fallthroughMatch =
    fallthrough === 'defaults' || compiled.length === 0 ? resolve(null) : null;
  const routePatterns = compiled.map((entry) => entry.route.repo);

  /** Repo resolution only: allowlist, first matching route, then fallthrough. */
  function resolveRepoRoute(repoFullName: string): RepoResolution {
    if (allowlist.length > 0 && !allowlistMatcher(repoFullName)) {
      return { kind: 'repo_not_allowed' };
    }

    const hit = compiled.find((entry) => entry.matcher(repoFullName));
    const match = hit === undefined ? fallthroughMatch : hit.resolved;
    if (match === null) {
      return { kind: 'no_route', matchedRoute: hit?.route.repo ?? null };
    }
    return { kind: 'match', match };
  }

  return {
    matchRoute(repoFullName: string, ref: ParsedRef): RouteDecision {
      const resolved = resolveRepoRoute(repoFullName);
      if (resolved.kind === 'repo_not_allowed') {
        return { skipped: 'repo_not_allowed', patternsTried: allowlist, matchedRoute: null };
      }
      if (resolved.kind === 'no_route') {
        return {
          skipped: 'no_route',
          patternsTried: routePatterns,
          matchedRoute: resolved.matchedRoute,
        };
      }

      const match = resolved.match;

      if (ref.kind === 'tag') {
        // A non-empty list is the only thing that enables tag relaying, and a
        // tag is NEVER matched against `branches` (7.6).
        if (match.tags.length === 0) {
          return { skipped: 'tags_disabled', patternsTried: [], matchedRoute: match.matchedRoute };
        }
        if (!match.tagMatcher(ref.name)) {
          return {
            skipped: 'tag_not_allowed',
            patternsTried: match.tags,
            matchedRoute: match.matchedRoute,
          };
        }
        return match;
      }

      if (!match.branchMatcher(ref.name)) {
        return {
          skipped: 'branch_not_allowed',
          patternsTried: match.branches,
          matchedRoute: match.matchedRoute,
        };
      }
      return match;
    },
    expectedSecretEnv(repoFullName: string): string | null | undefined {
      const resolved = resolveRepoRoute(repoFullName);
      if (resolved.kind !== 'match') return undefined;
      return resolved.match.webhookSecretEnv ?? null;
    },
  };
}
