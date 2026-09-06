import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES, createRelay, loadFixture, type Relay } from './harness.ts';

/** Every row of the 17.4 fixture catalogue, driven through the two mocks:
 *  status, Basecamp call count, order and exact bodies. */

const encoder = new TextEncoder();

let live: Relay | null = null;

function relay(...args: Parameters<typeof createRelay>): Relay {
  live = createRelay(...args);
  return live;
}

afterEach(() => {
  live?.restore();
  live = null;
});

function commitsOf(name: string): Array<{ id: string; message: string }> {
  const parsed = JSON.parse(FIXTURES[name] as string) as {
    commits: Array<{ id: string; message: string }>;
  };
  return parsed.commits;
}

/** A fixture re-serialized with one field changed. Never committed: the two-ref
 *  dedup case needs the identical commits under a second ref (17.4 note). */
function mutated(name: string, over: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  const parsed = JSON.parse(FIXTURES[name] as string) as Record<string, unknown>;
  return encoder.encode(JSON.stringify({ ...parsed, ...over }));
}

const row = (label: string, value: string): string =>
  `<tr><td nowrap><strong>${label}&nbsp;</strong></td><td>${value}<br>\n</td></tr>\n`;

const wide = (value: string): string => `<tr><td colspan="2">${value}<br>\n</td></tr>\n`;

const document_ = (rows: string, label: string, body: string): string =>
  '<div dir="ltr"><table dir="ltr" cellpadding="4">\n<tbody>\n' +
  rows +
  wide(`<strong>${label}</strong>`) +
  wide(body) +
  '</tbody>\n</table></div>';

interface CommitTable {
  repo?: string;
  refLabel?: string;
  ref?: string;
  author: string;
  files: string;
  changes: string;
  sha: string;
  body: string;
}

/** Every commit message ends with the one link in the table, to the commit. */
const viewCommit = (sha: string): string =>
  `<br><a href="https://github.com/your-org/your-repo/commit/${sha}">View the commit</a>`;

function commitTable(v: CommitTable): string {
  return document_(
    row('Repository', v.repo ?? 'your-org/your-repo') +
      row(v.refLabel ?? 'Branch', v.ref ?? 'main') +
      row('Author', v.author) +
      row('Files', v.files) +
      row('Changes', v.changes),
    'Commit message',
    v.body + viewCommit(v.sha),
  );
}

interface RollupTable {
  branch: string;
  files: string;
  authors: string;
  label: string;
  compare: string;
}

function rollupTable(v: RollupTable): string {
  return document_(
    row('Repository', 'your-org/your-repo') +
      row('Branch', v.branch) +
      row('Files', v.files) +
      row('Changes', 'N/A'),
    v.label,
    'Individual commits are not shown for this push.<br>Authors: ' +
      v.authors +
      `<br><a href="${v.compare}">View the full comparison</a>`,
  );
}

const STATS_ON = { FETCH_LINE_STATS: 'on' };

describe('push.normal.json, 3 commits on an allowed branch', () => {
  it('answers 202 and posts three golden bodies, in commit order', async () => {
    const r = relay({ env: STATS_ON });

    const res = await r.relay(loadFixture('push.normal.json'));

    expect(res.status).toBe(202);
    expect(r.enqueued).toHaveLength(1);
    expect(r.basecamp.calls).toHaveLength(3);
    expect(r.basecamp.maxInFlight).toBe(1);

    // Literal, from 8.1: the trailing `<br>\n` inside the last cell of every row
    // is load-bearing and a builder could hide its loss.
    expect(r.basecamp.contents()[0]).toBe(
      '<div dir="ltr"><table dir="ltr" cellpadding="4">\n' +
        '<tbody>\n' +
        '<tr><td nowrap><strong>Repository&nbsp;</strong></td><td>your-org/your-repo<br>\n' +
        '</td></tr>\n' +
        '<tr><td nowrap><strong>Branch&nbsp;</strong></td><td>main<br>\n' +
        '</td></tr>\n' +
        '<tr><td nowrap><strong>Author&nbsp;</strong></td><td>jane-doe<br>\n' +
        '</td></tr>\n' +
        '<tr><td nowrap><strong>Files&nbsp;</strong></td><td>1<br>\n' +
        '</td></tr>\n' +
        '<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>+42 / -7<br>\n' +
        '</td></tr>\n' +
        '<tr><td colspan="2"><strong>Commit message</strong><br>\n' +
        '</td></tr>\n' +
        '<tr><td colspan="2">Add the changelog entry for 1.4.0<br>' +
        '<a href="https://github.com/your-org/your-repo/commit/0b1c2d3e4f50617283940a1b2c3d4e5f60718293">' +
        'View the commit</a><br>\n' +
        '</td></tr>\n' +
        '</tbody>\n' +
        '</table></div>',
    );

    expect(r.basecamp.contents()[1]).toBe(
      commitTable({
        author: 'jane-doe',
        files: '3',
        changes: '+42 / -7',
        sha: '5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
        body: 'Drop the unused avatar helper<br><br>Co-authored-by: Sam Lee &lt;sam@example.com&gt;',
      }),
    );

    expect(r.basecamp.contents()[2]).toBe(
      commitTable({
        author: 'sam-lee',
        files: '1',
        changes: '+42 / -7',
        sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c',
        body: 'Cache the rendered footer<br><br>The footer is identical on every page.',
      }),
    );
  });

  it('renders N/A in Changes when the stats call 404s', async () => {
    const r = relay({ env: STATS_ON, github: { failAll: 'not_found' } });

    await r.relay(loadFixture('push.normal.json'));

    expect(r.basecamp.calls).toHaveLength(3);
    expect(r.basecamp.contents()[0]).toBe(
      commitTable({
        author: 'jane-doe',
        files: '1',
        changes: 'N/A',
        sha: '0b1c2d3e4f50617283940a1b2c3d4e5f60718293',
        body: 'Add the changelog entry for 1.4.0',
      }),
    );
  });

  it('returns its response before any GitHub or Basecamp fetch is invoked', async () => {
    const r = relay({ env: STATS_ON });

    const delivery = await r.deliver(loadFixture('push.normal.json'));

    expect(delivery.res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(0);
    expect(r.github.calls).toHaveLength(0);

    await delivery.settle();
    expect(r.basecamp.calls).toHaveLength(3);
  });

  it('posts one line for a commit delivered again on a second ref', async () => {
    const r = relay({ env: { ...STATS_ON, BRANCHES: 'main,develop' } });

    await r.relay(loadFixture('push.normal.json'));
    await r.relay(mutated('push.normal.json', { ref: 'refs/heads/develop' }));

    expect(r.enqueued).toHaveLength(2);
    expect(r.basecamp.calls).toHaveLength(3);
  });
});

describe('the rollup fixtures', () => {
  it('push.branch-create.json posts exactly one branch-create rollup', async () => {
    const r = relay({ env: { BRANCHES: 'main,release/*' } });

    const res = await r.relay(loadFixture('push.branch-create.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);
    expect(r.basecamp.contents()[0]).toBe(
      rollupTable({
        branch: 'release/2.0',
        files: '1',
        authors: 'jane-doe, sam-lee',
        label: 'New branch created',
        compare: 'https://github.com/your-org/your-repo/compare/000000000000...b3a774fd1404',
      }),
    );
    expect(r.github.calls).toHaveLength(0);
  });

  it('push.forced.json posts exactly one force-push rollup', async () => {
    const r = relay();

    const res = await r.relay(loadFixture('push.forced.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);
    expect(r.basecamp.contents()[0]).toBe(
      rollupTable({
        branch: 'main',
        files: '1',
        authors: 'jane-doe, sam-lee',
        label: 'Force push',
        compare: 'https://github.com/your-org/your-repo/compare/420377da02f0...f3d04611f21b',
      }),
    );
  });

  it('push.forced.json posts nothing at all with SKIP_FORCED_PUSHES on', async () => {
    const r = relay({ env: { SKIP_FORCED_PUSHES: 'true' } });

    const res = await r.relay(loadFixture('push.forced.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(0);
    expect(r.enqueued).toHaveLength(0);
  });

  it('push.large.json posts one cap rollup and no commit lines', async () => {
    const r = relay({ env: STATS_ON });

    const res = await r.relay(loadFixture('push.large.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);
    expect(r.github.calls).toHaveLength(0);
    expect(r.basecamp.contents()[0]).toBe(
      rollupTable({
        branch: 'main',
        files: '31',
        authors: 'jane-doe, sam-lee',
        label: 'More commits in this push',
        compare: 'https://github.com/your-org/your-repo/compare/da2933c8e6cd...08bb95241b07',
      }),
    );
    // The rollup carries no count of any kind (9.8).
    expect(r.basecamp.contents()[0]).not.toMatch(/\b30\b/);
  });
});

describe('the fixtures that must post nothing', () => {
  const silent: Array<[string, Record<string, unknown>]> = [
    ['push.branch-delete.json', {}],
    ['push.empty.json', {}],
    ['push.tag.json', {}],
    ['push.tag.json', { TAGS: 'v*' }],
    ['push.tag-with-commits.json', {}],
    ['push.non-distinct.json', {}],
    ['push.bot.json', { IGNORE_AUTHORS: 'dependabot[bot]' }],
  ];

  for (const [name, env] of silent) {
    it(`${name} with ${JSON.stringify(env)} answers 202 and posts nothing`, async () => {
      const r = relay({ env });

      const res = await r.relay(loadFixture(name));

      expect(res.status).toBe(202);
      expect(r.basecamp.calls).toHaveLength(0);
      expect(r.github.calls).toHaveLength(0);
    });
  }

  it('push.branch-delete.json dereferences no null head_commit', async () => {
    const r = relay();

    // `head_commit: null` with `commits: []`: the assertion is that nothing
    // throws on the way to the 202 (17.4).
    await expect(r.relay(loadFixture('push.branch-delete.json'))).resolves.toMatchObject({
      status: 202,
    });
    expect(r.enqueued).toHaveLength(0);
  });
});

describe('the fixtures that reach the renderer', () => {
  it('push.tag-with-commits.json posts one line with TAGS=v*', async () => {
    const r = relay({ env: { ...STATS_ON, TAGS: 'v*' } });

    const res = await r.relay(loadFixture('push.tag-with-commits.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);
    expect(r.basecamp.contents()[0]).toBe(
      commitTable({
        refLabel: 'Tag',
        ref: 'v0.1.0',
        author: 'jane-doe',
        files: '1',
        changes: '+42 / -7',
        sha: '5408f3511007dce8adc10b8e35e9b79a4b9790ef',
        body: 'Tag v0.1.0<br><br>Release notes in CHANGELOG.md.',
      }),
    );
  });

  it('push.merge.json drops the merge commit and posts both siblings, in order', async () => {
    const commits = commitsOf('push.merge.json');
    const mergeSha = commits[2]?.id as string;
    const r = relay({ env: STATS_ON, github: { mergeShas: [mergeSha] } });

    const res = await r.relay(loadFixture('push.merge.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(2);
    expect(r.basecamp.contents()[0]).toContain('Add retry budget to the poster');
    expect(r.basecamp.contents()[1]).toContain('Cover the retry budget with a test');
    expect(r.logs.all('push_skipped').map((line) => line.fields['reason'])).toEqual([
      'merge_commit',
    ]);
  });

  it('push.unknown-fields.json processes normally', async () => {
    const r = relay({ env: STATS_ON });

    const res = await r.relay(loadFixture('push.unknown-fields.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(2);
    expect(r.basecamp.contents()[0]).toContain('Unknown-field tolerance (1)');
  });

  it('push.astral.json survives the round trip with the astral characters intact', async () => {
    const r = relay({ env: STATS_ON });

    const res = await r.relay(loadFixture('push.astral.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);
    expect(r.basecamp.contents()[0]).toContain('Ship the 💥 release');
  });

  it('push.injection.json escapes the hostile ref, author and message', async () => {
    const r = relay({ env: { ...STATS_ON, BRANCHES: '**' } });

    const res = await r.relay(loadFixture('push.injection.json'));

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);

    const html = r.basecamp.contents()[0] as string;
    const withoutTags = html.replace(
      /<\/?(?:div|table|tbody|tr|td|strong|br|a|blockquote)(?:\s[^>]*)?>/g,
      '',
    );
    expect(withoutTags).not.toContain('<');
    expect(html).toContain('&lt;/td&gt;&lt;/tr&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // The author name is payload-derived too, and is the spoofing vector 11.1
    // names alongside the message.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

/** The pull request path end to end: one message per event, no GitHub call. */
describe('pull request events', () => {
  const PR_EVENT = { 'x-github-event': 'pull_request' };
  const REVIEW_EVENT = { 'x-github-event': 'pull_request_review' };

  const prTable = (v: {
    label: string;
    branch?: string;
    author?: string;
    files?: string;
    changes?: string;
    body: string;
  }): string =>
    document_(
      row('Repository', 'your-org/your-repo') +
        row('Branch', v.branch ?? 'feat/login → main') +
        row('Author', v.author ?? 'jane-doe') +
        row('Files', v.files ?? '7') +
        row('Changes', v.changes ?? '+180 / -24'),
      v.label,
      v.body,
    );

  const VIEW_PR =
    '<br><a href="https://github.com/your-org/your-repo/pull/42">View the pull request</a>';

  it('posts one table when a pull request is merged, and calls no GitHub API', async () => {
    const r = relay();

    const res = await r.relay(loadFixture('pr.merged.json'), PR_EVENT);

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);
    // The line counts ride along in the webhook payload.
    expect(r.github.calls).toHaveLength(0);
    expect(r.basecamp.contents()[0]).toBe(
      prTable({ label: 'Pull request #42 merged', body: `Add OAuth login flow${VIEW_PR}` }),
    );
  });

  it('separates opened, merged and closed-without-merging', async () => {
    for (const [fixture, label] of [
      ['pr.opened.json', 'Pull request #42 opened'],
      ['pr.merged.json', 'Pull request #42 merged'],
      ['pr.closed.json', 'Pull request #42 closed without merging'],
      ['pr.reopened.json', 'Pull request #42 reopened'],
    ] as const) {
      const r = relay();
      await r.relay(loadFixture(fixture), PR_EVENT);
      expect([fixture, r.basecamp.contents()[0]]).toEqual([
        fixture,
        prTable({ label, body: `Add OAuth login flow${VIEW_PR}` }),
      ]);
      r.restore();
    }
  });

  it('posts a review with its own label and N/A counts', async () => {
    const r = relay();

    const res = await r.relay(loadFixture('review.approved.json'), REVIEW_EVENT);

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(1);
    expect(r.basecamp.contents()[0]).toBe(
      prTable({
        label: 'Pull request #42 approved',
        author: 'sam-lee',
        files: 'N/A',
        changes: 'N/A',
        body:
          'Add OAuth login flow<br><a href="https://github.com/your-org/your-repo/pull/42' +
          '#pullrequestreview-900001">View the pull request</a>',
      }),
    );
  });

  it('answers 202 and posts nothing for a draft', async () => {
    const r = relay();

    const res = await r.relay(loadFixture('pr.draft.json'), PR_EVENT);

    expect(res.status).toBe(202);
    expect(r.basecamp.calls).toHaveLength(0);
  });

  it('posts the same pull request once, however many times it is delivered', async () => {
    const r = relay();

    await r.relay(loadFixture('pr.merged.json'), PR_EVENT);
    await r.relay(loadFixture('pr.merged.json'), PR_EVENT);

    expect(r.basecamp.calls).toHaveLength(1);
  });

  it('renders an injected title, head branch and author as inert text', async () => {
    const r = relay();

    await r.relay(loadFixture('pr.injection.json'), PR_EVENT);

    const html = r.basecamp.contents()[0] ?? '';
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt; → main');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>');
  });

  it('still answers 204 for an event it does not relay', async () => {
    const r = relay();

    const res = await r.relay(loadFixture('pr.opened.json'), { 'x-github-event': 'issues' });

    expect(res.status).toBe(204);
    expect(r.basecamp.calls).toHaveLength(0);
  });
});
