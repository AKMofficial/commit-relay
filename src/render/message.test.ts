import { describe, expect, it } from 'vitest';
import injectionRaw from '../../tests/fixtures/push.injection.json?raw';
import astralRaw from '../../tests/fixtures/push.astral.json?raw';
import { byteLength, contentBytes } from '../core/bytes.ts';
import type { RollupKind } from '../core/types.ts';
import { S } from './strings.ts';
import {
  __testOnly,
  ContentUnrenderableError,
  renderMessageBody,
  type RenderLimits,
} from './table.ts';
import {
  buildCommitTable,
  buildRollupTable,
  type CommitView,
  type RollupView,
} from './message.ts';

interface PushFixture {
  ref: string;
  compare: string;
  repository: { full_name: string };
  commits: { message: string; url: string; author: { name: string } }[];
}
const injection = JSON.parse(injectionRaw) as PushFixture;
const astral = JSON.parse(astralRaw) as PushFixture;

const { assembleDocument } = __testOnly;

const lim: RenderLimits = {
  bodyMaxCodePoints: 2000,
  contentMaxBytes: 16384,
  webOrigin: 'https://github.com',
};

const commit: CommitView = {
  repoFullName: 'your-org/your-repo',
  refKind: 'branch',
  refName: 'main',
  author: 'jane-doe',
  fileCount: 3,
  additions: 42,
  deletions: 7,
  message: 'Fix crash when the config file is empty',
  commitUrl: 'https://github.com/your-org/your-repo/commit/abc1234',
};

const rollup: RollupView = {
  kind: 'cap',
  repoFullName: 'your-org/your-repo',
  refKind: 'branch',
  refName: 'main',
  fileCount: 48,
  authors: ['jane-doe', 'sam-lee'],
  compareUrl: 'https://github.com/your-org/your-repo/compare/abc1234...def5678',
};

const doc = (...lines: string[]): string => lines.join('\n');

/** The one link every commit message ends with. */
const VIEW_COMMIT =
  '<br><a href="https://github.com/your-org/your-repo/commit/abc1234">View the commit</a>';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

const COMMIT_ROWS = [
  '<tr><td nowrap><strong>Repository&nbsp;</strong></td><td>your-org/your-repo<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Branch&nbsp;</strong></td><td>main<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Author&nbsp;</strong></td><td>jane-doe<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Files&nbsp;</strong></td><td>3<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>+42 / -7<br>',
  '</td></tr>',
];

// Section 8.1, verbatim.
const GOLDEN_8_1 = doc(
  '<div dir="ltr"><table dir="ltr" cellpadding="4">',
  '<tbody>',
  ...COMMIT_ROWS,
  '<tr><td colspan="2"><strong>Commit message</strong><br>',
  '</td></tr>',
  `<tr><td colspan="2">Fix crash when the config file is empty${VIEW_COMMIT}<br>`,
  '</td></tr>',
  '</tbody>',
  '</table></div>',
);

// Section 8.4 E, verbatim, kind: 'cap'.
const GOLDEN_ROLLUP_CAP = doc(
  '<div dir="ltr"><table dir="ltr" cellpadding="4">',
  '<tbody>',
  '<tr><td nowrap><strong>Repository&nbsp;</strong></td><td>your-org/your-repo<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Branch&nbsp;</strong></td><td>main<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Files&nbsp;</strong></td><td>48<br>',
  '</td></tr>',
  '<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>N/A<br>',
  '</td></tr>',
  '<tr><td colspan="2"><strong>More commits in this push</strong><br>',
  '</td></tr>',
  '<tr><td colspan="2">Individual commits are not shown for this push.<br>' +
    'Authors: jane-doe, sam-lee<br>' +
    '<a href="https://github.com/your-org/your-repo/compare/abc1234...def5678">' +
    'View the full comparison</a><br>',
  '</td></tr>',
  '</tbody>',
  '</table></div>',
);

// Section 8.6, verbatim: the colspan-free block-sibling layout.
const GOLDEN_8_6 = doc(
  '<div dir="ltr">',
  '<table dir="ltr" cellpadding="4">',
  '<tbody>',
  ...COMMIT_ROWS,
  '</tbody>',
  '</table>',
  '<strong>Commit message</strong><br>',
  `<blockquote>Fix crash when the config file is empty<br><br>Fixes #12${VIEW_COMMIT}<br>`,
  '</blockquote>',
  '</div>',
);

describe('buildCommitTable golden output', () => {
  it('matches the literal of section 8.1 byte for byte', () => {
    expect(buildCommitTable(commit, lim)).toBe(GOLDEN_8_1);
  });

  it('renders example B: blank-line runs collapse and the trailer is verbatim', () => {
    const message = doc(
      'Fix crash when the config file is empty',
      '',
      'The loader assumed `routes` was always an array, so an',
      'empty config file threw before validation could report it.',
      '',
      '',
      '',
      'Fixes #12',
      '',
      'Co-authored-by: Sam Lee <sam@example.com>',
    );
    const html = buildCommitTable({ ...commit, message }, lim);

    expect(html).toContain(
      doc(
        '<tr><td colspan="2">Fix crash when the config file is empty<br><br>' +
          'The loader assumed `routes` was always an array, so an<br>' +
          'empty config file threw before validation could report it.<br><br>' +
          'Fixes #12<br><br>' +
          `Co-authored-by: Sam Lee &lt;sam@example.com&gt;${VIEW_COMMIT}<br>`,
        '</td></tr>',
      ),
    );
  });

  it('renders example C: hostile markup is inert and the structure survives', () => {
    const message = doc(
      '</td></tr><script>alert(1)</script>',
      '',
      'Also: 5 < 6 && 7 > 6, "quoted", \'single\', A&B',
    );
    const html = buildCommitTable(
      { ...commit, author: '<img src=x onerror=alert(1)>', message },
      lim,
    );

    expect(html).toContain(
      doc(
        '<tr><td nowrap><strong>Author&nbsp;</strong></td>' +
          '<td>&lt;img src=x onerror=alert(1)&gt;<br>',
        '</td></tr>',
      ),
    );
    expect(html).toContain(
      doc(
        '<tr><td colspan="2">&lt;/td&gt;&lt;/tr&gt;&lt;script&gt;alert(1)&lt;/script&gt;<br><br>' +
          `Also: 5 &lt; 6 &amp;&amp; 7 &gt; 6, &quot;quoted&quot;, &#39;single&#39;, A&amp;B${VIEW_COMMIT}<br>`,
        '</td></tr>',
      ),
    );
  });

  it('renders example D: null stats give N/A, never +0 / -0', () => {
    const html = buildCommitTable({ ...commit, additions: null, deletions: null }, lim);

    expect(html).toContain(
      doc('<tr><td nowrap><strong>Files&nbsp;</strong></td><td>3<br>', '</td></tr>'),
    );
    expect(html).toContain(
      doc('<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>N/A<br>', '</td></tr>'),
    );
    expect(html).not.toContain('+0 / -0');

    const zeroed = buildCommitTable({ ...commit, additions: 0, deletions: 0 }, lim);
    expect(zeroed).toContain('<td>+0 / -0<br>');
  });

  it('renders an empty message as the commit link alone, never a missing row', () => {
    const html = buildCommitTable({ ...commit, message: '' }, lim);
    expect(html).toContain(doc(`<tr><td colspan="2">${VIEW_COMMIT.slice(4)}<br>`, '</td></tr>'));
    expect(html.match(/<tr>/g)).toHaveLength(7);

    const noUrl = buildCommitTable({ ...commit, message: '', commitUrl: null }, lim);
    expect(noUrl).toContain(doc('<tr><td colspan="2"><br>', '</td></tr>'));
  });

  it('renders a null file count as N/A', () => {
    expect(buildCommitTable({ ...commit, fileCount: null }, lim)).toContain(
      doc('<tr><td nowrap><strong>Files&nbsp;</strong></td><td>N/A<br>', '</td></tr>'),
    );
  });
});

describe('the render pipeline order', () => {
  it('escapes before inserting <br>, so newlines are tags and not entities', () => {
    const html = buildCommitTable({ ...commit, message: 'one\ntwo' }, lim);
    expect(html).toContain('one<br>two');
    expect(html).not.toContain('&lt;br&gt;');
  });

  it('truncates the source before escaping, so no slice lands mid-entity', () => {
    const message = `${'a'.repeat(8)}&${'b'.repeat(40)}`;
    const html = buildCommitTable({ ...commit, message }, { ...lim, bodyMaxCodePoints: 10 });

    expect(html).toContain('aaaaaaaa&amp;b');
    expect(html).not.toMatch(/&(?!(amp|lt|gt|quot|#39|nbsp);)/);
  });

  it('strips control characters from the message while keeping the newline', () => {
    const controls = cp(0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f);
    const html = buildCommitTable({ ...commit, message: `a${controls}b\nc` }, lim);
    expect(html).toContain('ab<br>c');
  });

  it('strips bidi and invisible characters from EVERY payload-derived field', () => {
    const rlo = cp(0x202e);
    const zwsp = cp(0x200b);
    const bom = cp(0xfeff);
    const isolate = cp(0x2066);

    const html = buildCommitTable(
      {
        ...commit,
        repoFullName: `your-org${zwsp}/your-repo${bom}`,
        author: `alice${rlo}`,
        message: `subject${isolate}`,
      },
      lim,
    );
    expect(html).toContain('<td>your-org/your-repo<br>');
    expect(html).toContain('<td>alice<br>');
    expect(html).toContain(`<td colspan="2">subject${VIEW_COMMIT}<br>`);
    for (const c of [rlo, zwsp, bom, isolate]) expect(html).not.toContain(c);

    const rolled = buildRollupTable(
      {
        ...rollup,
        repoFullName: `your-org/your-repo${rlo}`,
        refName: `main${rlo}`,
        authors: [`jane-doe${rlo}`, `sam${zwsp}-lee`],
      },
      lim,
    );
    expect(rolled).toContain('<td>your-org/your-repo<br>');
    expect(rolled).toContain('<td>main<br>');
    expect(rolled).toContain('Authors: jane-doe, sam-lee<br>');
    expect(rolled).not.toContain(rlo);
  });

  it('normalizes CRLF and a lone CR to LF before counting for truncation', () => {
    expect(renderMessageBody('a\r\nb\rc', 2000)).toBe('a<br>b<br>c');
    expect(renderMessageBody('ab\r\ncd', 4)).toBe(renderMessageBody('ab\ncd', 4));
  });

  it('collapses five consecutive blank lines to exactly one <br><br>', () => {
    expect(renderMessageBody(`a${'\n'.repeat(6)}b`, 2000)).toBe('a<br><br>b');
  });

  it('escapes an ampersand exactly once', () => {
    expect(renderMessageBody('A&B', 2000)).toBe('A&amp;B');
    expect(renderMessageBody('A&B', 2000)).not.toContain('&amp;amp;');
  });

  it('never splits a surrogate pair, using the astral fixture', () => {
    const source = astral.commits[0]?.message ?? '';
    for (let max = 1; max <= 12; max++) {
      const out = renderMessageBody(source, max);
      for (const unit of out) {
        const code = unit.codePointAt(0) ?? 0;
        expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
      }
    }
  });

  it('normalizes an astral author name to NFC and keeps the emoji intact', () => {
    const author = astral.commits[0]?.author.name ?? '';
    const html = buildCommitTable({ ...commit, author }, lim);
    expect(html).toContain(`<td>Jos${cp(0xe9)} ${cp(0x1f680)} ${cp(0xc5)}ngstr${cp(0xf6)}m<br>`);
  });
});

describe('the byte ceiling', () => {
  it('adds no inflation for a 4-byte emoji', () => {
    const boom = cp(0x1f4a5);
    expect(byteLength(boom)).toBe(4);
    expect(byteLength(renderMessageBody(boom, 2000))).toBe(4);
  });

  it('inflates the five ASCII escapable characters by at most 5x', () => {
    const worst = '&\'<>"'.repeat(100);
    expect(byteLength(renderMessageBody(worst, 2000))).toBeLessThanOrEqual(
      byteLength(worst) * 5,
    );
  });

  it('is asserted on the assembled envelope, not on the body alone', () => {
    const html = buildCommitTable({ ...commit, message: "'".repeat(2000) }, lim);
    expect(contentBytes(html)).toBeLessThanOrEqual(lim.contentMaxBytes);
  });

  it('fits the JSON envelope at contentMaxBytes even when quotes inflate the wire body', () => {
    const cap = 1200;
    const limLocal = { ...lim, contentMaxBytes: cap };
    const message = '"'.repeat(120);
    const html = buildCommitTable({ ...commit, message }, limLocal);
    expect(contentBytes(html)).toBeLessThanOrEqual(cap);
  });

  it('never exceeds contentMaxBytes by envelope measure across a spread of caps', () => {
    for (const cap of [1024, 4096, 8192, 16384]) {
      const limLocal = { ...lim, contentMaxBytes: cap };
      const commitHtml = buildCommitTable(
        { ...commit, message: 'line\n'.repeat(500) + '"'.repeat(200) },
        limLocal,
      );
      expect(contentBytes(commitHtml)).toBeLessThanOrEqual(cap);
      const rollupHtml = buildRollupTable(
        {
          kind: 'cap',
          repoFullName: 'your-org/your-repo',
          refKind: 'branch',
          refName: 'main',
          fileCount: 12,
          authors: ['a', 'b', 'c', 'd', 'e', 'f'],
          compareUrl: 'https://github.com/your-org/your-repo/compare/a...b',
        },
        limLocal,
      );
      expect(contentBytes(rollupHtml)).toBeLessThanOrEqual(cap);
    }
  });

  it('falls back to level 2 - subject plus an anchored commit link - when it must', () => {
    const message = doc('Fix crash when the config file is empty', '', 'body '.repeat(800));
    const full = buildCommitTable({ ...commit, message }, lim);
    const capped = { ...lim, contentMaxBytes: byteLength(full) - 1 };
    const short = buildCommitTable({ ...commit, message }, capped);

    expect(short).toContain(
      doc(
        '<tr><td colspan="2">Fix crash when the config file is empty<br>' +
          '<a href="https://github.com/your-org/your-repo/commit/abc1234">' +
          'View the commit</a><br>',
        '</td></tr>',
      ),
    );
    expect(contentBytes(short)).toBeLessThanOrEqual(capped.contentMaxBytes);
  });

  it('hard-clips a 400 KB single-line subject rather than emitting it', () => {
    const message = 'z& '.repeat(140_000);
    const empty = buildCommitTable({ ...commit, message: '' }, lim);
    const link = `<br><a href="${commit.commitUrl ?? ''}">${S.viewCommit}</a>`;
    const tight = { ...lim, contentMaxBytes: contentBytes(empty) + contentBytes(link) + 200 };
    const html = buildCommitTable({ ...commit, message }, tight);

    expect(contentBytes(html)).toBeLessThanOrEqual(tight.contentMaxBytes);
    expect(html).toContain('<a href="https://github.com/your-org/your-repo/commit/abc1234">');
    expect(html).not.toMatch(/&(?!(amp|lt|gt|quot|#39|nbsp);)/);
    expect(html.match(/<tr>/g)).toHaveLength(7);
  });

  it('throws rather than posting a document that still does not fit', () => {
    const message = 'z'.repeat(1000);
    expect(() => buildCommitTable({ ...commit, message }, { ...lim, contentMaxBytes: 64 })).toThrow(
      ContentUnrenderableError,
    );
  });
});

describe('hrefs', () => {
  it('renders a rejected commit URL as escaped plain text with no anchor', () => {
    const message = doc('Subject', '', 'x '.repeat(2000));

    const rejected: Record<string, string> = {
      'javascript:alert(1)': 'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>':
        'data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;',
      'http://github.com/your-org/your-repo/commit/abc1234':
        'http://github.com/your-org/your-repo/commit/abc1234',
      'https://evil.example/your-org/your-repo/commit/abc1234':
        'https://evil.example/your-org/your-repo/commit/abc1234',
      'https://github.com@evil.example/x': 'https://github.com@evil.example/x',
    };

    for (const [bad, asText] of Object.entries(rejected)) {
      const full = buildCommitTable({ ...commit, message, commitUrl: bad }, lim);
      const capped = { ...lim, contentMaxBytes: byteLength(full) - 1 };
      const html = buildCommitTable({ ...commit, message, commitUrl: bad }, capped);
      expect(html).not.toContain('<a ');
      expect(html).not.toContain('href');
      // The rejected URL still takes the link's own line, as inert text.
      expect(html).toContain(doc(`<tr><td colspan="2">Subject<br>${asText}<br>`, '</td></tr>'));
    }

    const unlinked = buildCommitTable({ ...commit, message, commitUrl: null }, lim);
    const noUrl = buildCommitTable(
      { ...commit, message, commitUrl: null },
      { ...lim, contentMaxBytes: byteLength(unlinked) - 1 },
    );
    expect(noUrl).not.toContain('<a ');
    expect(noUrl).toContain(doc('<tr><td colspan="2">Subject<br>', '</td></tr>'));
  });

  it('renders a rejected compare URL as escaped plain text with no anchor', () => {
    const html = buildRollupTable(
      { ...rollup, compareUrl: 'https://evil.example/compare/a...b' },
      lim,
    );
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
    expect(html).toContain('Authors: jane-doe, sam-lee<br>https://evil.example/compare/a...b<br>');
  });

  it('omits the link slot entirely when there is no compare URL', () => {
    const html = buildRollupTable({ ...rollup, compareUrl: null }, lim);
    expect(html).not.toContain('<a ');
    expect(html).toContain('Authors: jane-doe, sam-lee<br><br>');
  });
});

describe('buildRollupTable', () => {
  it('matches the literal of section 8.4 E byte for byte for kind cap', () => {
    expect(buildRollupTable(rollup, lim)).toBe(GOLDEN_ROLLUP_CAP);
  });

  it('differs between the three kinds in the row-5 label and nothing else', () => {
    const labels: Record<RollupKind, string> = {
      cap: S.rollupCap,
      branch_create: S.rollupBranchCreate,
      forced: S.rollupForced,
    };

    for (const kind of ['cap', 'branch_create', 'forced'] as const) {
      const html = buildRollupTable({ ...rollup, kind }, lim);
      expect(html).toBe(
        GOLDEN_ROLLUP_CAP.replace(
          `<strong>${S.rollupCap}</strong>`,
          `<strong>${labels[kind]}</strong>`,
        ),
      );
      expect(html).toContain(`<tr><td colspan="2"><strong>${labels[kind]}</strong><br>`);
    }
  });

  it('renders Changes as N/A and carries no remainder count', () => {
    const html = buildRollupTable(rollup, lim);
    expect(html).toContain(
      doc('<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>N/A<br>', '</td></tr>'),
    );
    expect(html).not.toMatch(/\d+ more/);
    expect(html.match(/<tr>/g)).toHaveLength(6);
  });

  it('renders a null file count as N/A', () => {
    expect(buildRollupTable({ ...rollup, fileCount: null }, lim)).toContain(
      doc('<tr><td nowrap><strong>Files&nbsp;</strong></td><td>N/A<br>', '</td></tr>'),
    );
  });

  it('caps a long author list and stays within contentMaxBytes', () => {
    const authors = Array.from({ length: 500 }, (_, i) => `author-number-${i}-with-a-long-name`);
    const tight = { ...lim, contentMaxBytes: 4096 };
    const html = buildRollupTable({ ...rollup, authors }, tight);
    expect(byteLength(html)).toBeLessThanOrEqual(tight.contentMaxBytes);
    expect(html).toContain('+495 more');
  });
});

describe('the 8.6 colspan-free layout', () => {
  it('produces the block-sibling document byte for byte', () => {
    const rows = COMMIT_ROWS.map((line) => `${line}\n`).join('');
    const body = `Fix crash when the config file is empty<br><br>Fixes #12${VIEW_COMMIT}`;
    expect(assembleDocument(rows, S.commitMessage, body, false)).toBe(GOLDEN_8_6);
  });

  it('produces the section 8.1 document when the switch is on', () => {
    const rows = COMMIT_ROWS.map((line) => `${line}\n`).join('');
    const body = `Fix crash when the config file is empty${VIEW_COMMIT}`;
    expect(assembleDocument(rows, S.commitMessage, body, true)).toBe(GOLDEN_8_1);
    expect(assembleDocument(rows, S.commitMessage, body)).toBe(GOLDEN_8_1);
  });

  it('keeps row order and uses no colspan in the fallback', () => {
    const rows = COMMIT_ROWS.map((line) => `${line}\n`).join('');
    const html = assembleDocument(rows, S.commitMessage, 'body', false);
    expect(html).not.toContain('colspan');
    expect(html.indexOf('</table>')).toBeLessThan(html.indexOf('<strong>Commit message'));
    expect(html.indexOf('<strong>Commit message')).toBeLessThan(html.indexOf('<blockquote>'));
  });
});

describe('the injection fixture', () => {
  const c = injection.commits[0];
  const HOSTILE_REPO = 'your-org/<b>repo</b>';
  const view: CommitView = {
    repoFullName: HOSTILE_REPO,
    refKind: 'branch',
    refName: injection.ref.replace('refs/heads/', ''),
    author: c?.author.name ?? '',
    fileCount: 2,
    additions: null,
    deletions: null,
    message: c?.message ?? '',
    commitUrl: c?.url ?? null,
  };
  const html = buildCommitTable(view, lim);

  const withoutOwnTags = (s: string): string =>
    s.replace(/<\/?(?:div|table|tbody|tr|td|strong|br|a|blockquote)(?:\s[^<>]*)?>/g, '');

  it('leaves no < in the output that the renderer did not emit', () => {
    expect(withoutOwnTags(html)).not.toContain('<');
    expect(withoutOwnTags(html)).not.toContain('>');
  });

  it('keeps the table structure intact and renders the injected markup as text', () => {
    expect(html.match(/<tr>/g)).toHaveLength(7);
    expect(html.match(/<\/tr>/g)).toHaveLength(7);
    expect(html.startsWith('<div dir="ltr"><table dir="ltr" cellpadding="4">')).toBe(true);
    expect(html.endsWith('</tbody>\n</table></div>')).toBe(true);
    expect(html).toContain('&lt;/td&gt;&lt;/tr&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('escapes the repository, author and branch values, not only the message', () => {
    expect(html).toContain(
      doc(
        '<tr><td nowrap><strong>Repository&nbsp;</strong></td>' +
          '<td>your-org/&lt;b&gt;repo&lt;/b&gt;<br>',
        '</td></tr>',
      ),
    );
    expect(html).toContain(
      doc(
        '<tr><td nowrap><strong>Author&nbsp;</strong></td>' +
          '<td>&lt;img src=x onerror=alert(1)&gt;<br>',
        '</td></tr>',
      ),
    );

    const branch = injection.ref.replace('refs/heads/', '');
    // The commit table carries the branch too now, and the branch name is
    // contributor-controlled on a public repo just like the message is.
    expect(html).toContain(
      doc(
        '<tr><td nowrap><strong>Branch&nbsp;</strong></td>' +
          '<td>&lt;script&gt;x&lt;/script&gt;<br>',
        '</td></tr>',
      ),
    );

    const rolled = buildRollupTable(
      {
        ...rollup,
        repoFullName: HOSTILE_REPO,
        refName: branch,
        authors: [c?.author.name ?? ''],
        compareUrl: injection.compare,
      },
      lim,
    );
    expect(rolled).toContain(
      doc(
        '<tr><td nowrap><strong>Branch&nbsp;</strong></td>' +
          '<td>&lt;script&gt;x&lt;/script&gt;<br>',
        '</td></tr>',
      ),
    );
    expect(rolled).toContain('Authors: &lt;img src=x onerror=alert(1)&gt;<br>');
    expect(withoutOwnTags(rolled)).not.toContain('<');
  });

  it('strips the fixture control and bidi characters from the rendered output', () => {
    for (const bad of [cp(0x200b), cp(0x202e), cp(0x202c), cp(0x07)]) {
      expect(html).not.toContain(bad);
    }
    expect(html).toContain(cp(0x1f4a5));
  });
});
