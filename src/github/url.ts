/** The only place a GitHub API URL is built (9.5, 11.1): no concatenation
 *  against GITHUB_API_BASE or a route's githubApiBase exists elsewhere. */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;

export function isValidSegment(value: string): boolean {
  return SEGMENT.test(value);
}

export function isValidSha(value: string): boolean {
  return SHA.test(value);
}

export function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (owner === undefined || repo === undefined) return null;
  if (!isValidSegment(owner) || !isValidSegment(repo)) return null;
  return { owner, repo };
}

/** Origin and path prefix are re-checked after `new URL()` normalization: without
 *  it a GHES path-prefixed base can be climbed out of, `Authorization` still attached (11.1). */
export function commitUrl(base: string, owner: string, repo: string, sha: string): string | null {
  if (!isValidSegment(owner) || !isValidSegment(repo) || !isValidSha(sha)) return null;

  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') return null;

  const prefix = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
  const path =
    `${prefix}repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/commits/${encodeURIComponent(sha)}`;

  let url: URL;
  try {
    url = new URL(path, baseUrl);
  } catch {
    return null;
  }

  if (url.origin !== baseUrl.origin) return null;
  if (!url.pathname.startsWith(prefix)) return null;

  url.search = '';
  url.searchParams.set('per_page', '1');
  return url.toString();
}
