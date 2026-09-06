# Contributing to commit-relay

Thanks for helping. This is a small project on purpose: two runtime dependencies, no
database, no web UI, one HTTP route that matters. Contributions that keep it that way
are the easiest ones to merge.

## Setup

Five commands per target, from a clean clone.

**Workers target**

```bash
git clone https://github.com/AKMofficial/commit-relay.git
cd commit-relay
corepack enable && pnpm install
cp .dev.vars.example .dev.vars
pnpm dev:workers
```

**Node target**

```bash
git clone https://github.com/AKMofficial/commit-relay.git
cd commit-relay
corepack enable && pnpm install
cp .env.example .env
pnpm dev:node
```

`GITHUB_WEBHOOK_SECRET` must be generated, not copied, the literals shipped in
`.env.example` and `.dev.vars.example` are on a boot denylist and will be refused:

```bash
openssl rand -hex 32
```

Every test runs fully offline with no real credentials: no Basecamp account and no
GitHub repo required. If you want to watch a rendered message without a Basecamp
account, run `node scripts/mock-basecamp.ts` and point `BASECAMP_API_BASE` at it.

## Gates

Run these before you push. CI runs the same ones, split into separate steps so the log
says which target broke.

```bash
pnpm lint
pnpm exec tsc -p tsconfig.workers.json --noEmit
pnpm exec tsc -p tsconfig.node.json --noEmit
pnpm exec tsc -p tsconfig.tests.json --noEmit
pnpm test:workers
pnpm test:node
pnpm build:workers
bash scripts/check-placeholders.sh
pnpm ls --prod --depth Infinity --json | node scripts/check-deps.mjs
```

`pnpm test` also runs `tests/invariants.test.ts`, which greps `src/**` for the five
rules in [docs/INVARIANTS.md](./docs/INVARIANTS.md), read that file before touching
credential comparisons, rendering, or outbound hosts.

## Commits

**Conventional Commits.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`,
`ci:`, `build:`, `perf:`. A `!` or a `BREAKING CHANGE:` footer marks a major change, 
see the public API surface table in `CHANGELOG.md` for what qualifies.

**DCO sign-off, no CLA.** Every commit carries a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/). Pass `-s` when
you commit:

```
git commit -s -m "fix: reject a ref longer than 512 bytes before glob matching"
```

Add an entry to `CHANGELOG.md` under `[Unreleased]` in the same PR.

## De-branding rules

No organization, repository, Basecamp room, bucket, account, person, or brand name
appears anywhere outside the sanctioned placeholder set. Test fixtures
(`tests/fixtures/**`, `*.test.ts`) and the screenshot data in
`scripts/render-screenshot.ts` use the placeholder repository `your-org/your-repo`;
every user-facing file, README, docs, examples, workflows, carries this project's
real slug `AKMofficial/commit-relay` and the real handle `@AKMofficial` in
`CODEOWNERS`. The rest of the placeholder set is exactly: account id `1234567`;
bucket id `2345678`; chat id `7654321`; author `Jane Doe` / `jane-doe` /
`jane@example.com`; second author `Sam Lee` / `sam-lee` / `sam@example.com`; bot
author `dependabot[bot]`. The three ids are deliberately distinct so an example
can never hide the bucket-for-chat swap. `ACCOUNT_ID` appears only as the URL path
segment inside the endpoint template, never as the value of an environment variable.

The rest is mechanical, and `scripts/check-placeholders.sh` enforces it in CI:

1. No identity-shaped literal outside the sanctioned set.
2. No literal numeric id of 7 or more digits outside `tests/fixtures/**` and `docs/**`,
   other than the three sanctioned ids and SHA- or timestamp-shaped values.
3. No `<owner>`, `<handle>`, `<sha>`, `TODO`, or `FIXME` in `src/**`. `USER_AGENT` and
   the docs URL in the boot-error message are derived at boot from `package.json`, so a
   fork is correct with zero edits.
4. Every `http(s)://` host in `src/**` is on the allowlist: `api.github.com` and
   `3.basecampapi.com`. Everything else comes from config.
5. No `BASECAMP_*` key in a committed `vars` block of `wrangler.jsonc` or `wrangler.toml`,
   or in a `docker-compose.yml` `environment:` block, placeholder values included.
   Basecamp config reaches the service only as a secret.

The guard matches shapes, never brand strings: a public denylist of the owner's org and
room names would publish exactly what it exists to suppress. A private denylist belongs
in an untracked local file or a repo secret, never in a tracked file.

Two more rules a reviewer checks by hand: every new behaviour must be reachable through
configuration rather than by editing code, and no user-visible string is added outside
`src/render/strings.ts`.

## TypeScript rules

**Relative imports carry the `.ts` extension.** `import { render } from './message.ts'`,
not `'./message'` and not `'./message.js'`. Node 24 runs the TypeScript sources directly
and resolves the specifier as written.

**`erasableSyntaxOnly` is on.** Type syntax must erase to nothing at runtime, so these
are prohibited outright:

- `enum`: use a `const` object plus a union type.
- `namespace`: use modules.
- Constructor parameter properties (`constructor(private readonly x: T)`): declare the
  field and assign it in the body.

Also forbidden by the same rule: `declare` fields with initialisers, and the legacy
`import x = require(...)` / `export =` forms.
