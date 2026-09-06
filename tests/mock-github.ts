/** Serves the committed `commit.stats.*` fixtures by sha and never reads the
 *  Authorization header, so the suite runs with no credentials (15). */

import statsJson from './fixtures/commit.stats.json?raw';
import statsMergeJson from './fixtures/commit.stats.merge.json?raw';

/** The failure modes 9.5 requires the enricher to survive. `timeout` uses the
 *  real `AbortSignal.timeout` rejection: deterministic where a stall is not. */
export type GitHubFailure = 'not_found' | 'forbidden' | 'rate_limited' | 'server_error' | 'timeout';

export interface GitHubMockOptions {
  /** Shas answered with `commit.stats.merge.json`, whose `parents.length` is 2. */
  mergeShas?: Iterable<string>;
  /** Per-sha failure, keyed on the full 40-character id. */
  failures?: Record<string, GitHubFailure>;
  /** Applied to every sha with no entry in `failures`. */
  failAll?: GitHubFailure;
}

export interface GitHubMock {
  /** Requested shas, in the order the enricher asked for them. */
  readonly calls: string[];
  matches(url: string): boolean;
  handle(url: string): Promise<Response>;
}

const COMMIT_PATH = /\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})$/;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function failureResponse(mode: Exclude<GitHubFailure, 'timeout'>): Response {
  if (mode === 'not_found') {
    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  }
  if (mode === 'forbidden') {
    return new Response(JSON.stringify({ message: 'Resource not accessible' }), {
      status: 403,
      headers: JSON_HEADERS,
    });
  }
  if (mode === 'rate_limited') {
    return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
      status: 403,
      headers: {
        ...JSON_HEADERS,
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
        'retry-after': '1',
      },
    });
  }
  return new Response(JSON.stringify({ message: 'Server Error' }), {
    status: 500,
    headers: JSON_HEADERS,
  });
}

export function createGitHubMock(options: GitHubMockOptions = {}): GitHubMock {
  const merges = new Set(options.mergeShas ?? []);
  const failures = options.failures ?? {};
  const calls: string[] = [];

  return {
    calls,

    matches(url: string): boolean {
      return COMMIT_PATH.test(new URL(url).pathname);
    },

    handle(url: string): Promise<Response> {
      const match = COMMIT_PATH.exec(new URL(url).pathname);
      if (match === null) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            headers: JSON_HEADERS,
          }),
        );
      }
      const sha = match[1] as string;
      calls.push(sha);

      const mode = failures[sha] ?? options.failAll;
      if (mode === 'timeout') {
        return Promise.reject(new DOMException('The operation was aborted', 'TimeoutError'));
      }
      if (mode !== undefined) return Promise.resolve(failureResponse(mode));

      return Promise.resolve(
        new Response(merges.has(sha) ? statsMergeJson : statsJson, {
          status: 200,
          headers: JSON_HEADERS,
        }),
      );
    },
  };
}
