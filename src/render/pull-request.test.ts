import { describe, expect, it } from 'vitest';
import { contentBytes } from '../core/bytes.ts';
import { ContentUnrenderableError, type RenderLimits } from './table.ts';
import { buildPullRequestTable, type PullRequestView } from './pull-request.ts';
import injectionRaw from '../../tests/fixtures/pr.injection.json?raw';

const lim: RenderLimits = {
  bodyMaxCodePoints: 2000,
  contentMaxBytes: 16384,
  webOrigin: 'https://github.com',
};

const pr: PullRequestView = {
  kind: 'merged',
  repoFullName: 'your-org/your-repo',
  headRef: 'feat/login',
  baseRef: 'main',
  number: 42,
  author: 'jane-doe',
  fileCount: 7,
  additions: 180,
  deletions: 24,
  title: 'Add OAuth login flow',
  htmlUrl: 'https://github.com/your-org/your-repo/pull/42',
};

const doc = (...lines: string[]): string => lines.join('\n');

const GOLDEN_MERGED = doc(
  '<div dir="ltr"><table dir="ltr" cellpadding="4">',
  '<tbody>',
  '<tr><td nowrap><strong>Repository&nbsp;</strong></td><td>your-org/your-repo<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Branch&nbsp;</strong></td><td>feat/login → main<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Author&nbsp;</strong></td><td>jane-doe<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Files&nbsp;</strong></td><td>7<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>+180 / -24<br>',
  '</td></tr>',
  '<tr><td colspan="2"><strong>Pull request #42 merged</strong><br>',
  '</td></tr>',
  '<tr><td colspan="2">Add OAuth login flow<br>' +
    '<a href="https://github.com/your-org/your-repo/pull/42">View the pull request</a><br>',
  '</td></tr>',
  '</tbody>',
  '</table></div>',
);

describe('buildPullRequestTable golden output', () => {
  it('matches the merged literal byte for byte', () => {
    expect(buildPullRequestTable(pr, lim)).toBe(GOLDEN_MERGED);
  });

  it('carries the same five label rows as a commit table, in the same order', () => {
    const labels = [...buildPullRequestTable(pr, lim).matchAll(/<strong>([^<]+?)&nbsp;<\/strong>/g)].map(
      (m) => m[1],
    );
    expect(labels).toEqual(['Repository', 'Branch', 'Author', 'Files', 'Changes']);
  });

  it('renders the branch row as head to base', () => {
    expect(buildPullRequestTable(pr, lim)).toContain('<td>feat/login → main<br>');
  });

  it('gives every kind its own label and never free text', () => {
    const label = (kind: PullRequestView['kind']): string => {
      const match = /<strong>(Pull request[^<]*)<\/strong>/.exec(
        buildPullRequestTable({ ...pr, kind }, lim),
      );
      return match?.[1] ?? '';
    };
    expect(label('opened')).toBe('Pull request #42 opened');
    expect(label('merged')).toBe('Pull request #42 merged');
    expect(label('closed')).toBe('Pull request #42 closed without merging');
    expect(label('reopened')).toBe('Pull request #42 reopened');
    expect(label('ready_for_review')).toBe('Pull request #42 ready for review');
    expect(label('review_approved')).toBe('Pull request #42 approved');
    expect(label('review_changes_requested')).toBe('Pull request #42 changes requested');
  });

  it('renders N/A rather than +0 / -0 when a review carries no line counts', () => {
    const html = buildPullRequestTable(
      { ...pr, kind: 'review_approved', fileCount: null, additions: null, deletions: null },
      lim,
    );
    expect(html).toContain('<td>N/A<br>');
    expect(html).not.toContain('+0 / -0');
  });

  it('still renders +0 / -0 when the counts really are zero', () => {
    expect(buildPullRequestTable({ ...pr, additions: 0, deletions: 0 }, lim)).toContain(
      '<td>+0 / -0<br>',
    );
  });

  it('drops the anchor for an off-origin URL but still shows it as inert text', () => {
    const html = buildPullRequestTable({ ...pr, htmlUrl: 'https://evil.example/pull/42' }, lim);
    expect(html).not.toContain('<a href=');
    expect(html).toContain('https://evil.example/pull/42');
  });

  it('falls back to the link alone when the title cannot fit', () => {
    const view = { ...pr, title: 'x'.repeat(5000) };
    const bare = contentBytes(buildPullRequestTable({ ...pr, title: '' }, lim));
    const capped = { ...lim, contentMaxBytes: bare + 8 };
    const html = buildPullRequestTable(view, capped);
    expect(contentBytes(html)).toBeLessThanOrEqual(capped.contentMaxBytes);
    expect(html).toContain('View the pull request');
    expect(html).not.toContain('xxxx');
  });

  it('never exceeds contentMaxBytes across a spread of caps, or refuses outright', () => {
    for (const cap of [512, 1024, 4096, 16384]) {
      const capped = { ...lim, contentMaxBytes: cap };
      let html: string;
      try {
        html = buildPullRequestTable({ ...pr, title: 'long '.repeat(2000) }, capped);
      } catch (error) {
        expect(error).toBeInstanceOf(ContentUnrenderableError);
        continue;
      }
      expect(contentBytes(html)).toBeLessThanOrEqual(cap);
    }
  });

  it('drops rather than clipping the frame when the budget is brutal', () => {
    // Below the link-only frame there is nothing left to shorten. Clipping the
    // document would post unclosed tags, which 8.5 forbids, so the builder
    // throws and the poster records a content_unrenderable drop.
    expect(() => buildPullRequestTable(pr, { ...lim, contentMaxBytes: 64 })).toThrow(
      ContentUnrenderableError,
    );
  });
});

describe('the injection fixture (12.1)', () => {
  const payload = JSON.parse(injectionRaw) as {
    pull_request: { title: string; head: { ref: string }; user: { login: string } };
  };
  const html = buildPullRequestTable(
    {
      ...pr,
      kind: 'opened',
      title: payload.pull_request.title,
      headRef: payload.pull_request.head.ref,
      author: payload.pull_request.user.login,
    },
    lim,
  );

  const withoutOwnTags = (s: string): string =>
    s.replace(/<\/?(?:div|table|tbody|tr|td|strong|br|a|blockquote)(?:\s[^<>]*)?>/g, '');

  it('leaves no < or > in the output that the renderer did not emit', () => {
    expect(withoutOwnTags(html)).not.toContain('<');
    expect(withoutOwnTags(html)).not.toContain('>');
  });

  it('keeps the table intact and renders the injected markup as text', () => {
    expect(html.match(/<tr>/g)).toHaveLength(7);
    expect(html).toContain('&lt;/td&gt;&lt;/tr&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('escapes the head branch and the author, not only the title', () => {
    expect(html).toContain('<td>&lt;script&gt;x&lt;/script&gt; → main<br>');
    expect(html).toContain('<td>&lt;img src=x onerror=alert(1)&gt;<br>');
  });
});
