# Configuration reference

Every variable, every default, and the full routing semantics. The authoritative source
for the list below is `src/config/schema.ts`; this document explains it.

Related: [Basecamp setup](./basecamp-setup.md) · [Cloudflare runbook](./cloudflare-setup.md) · [Basecamp compatibility log](./basecamp-compat.md) · [Node runbook](./node-setup.md)

## Contents

- [Precedence](#precedence)
- [Boot validation](#boot-validation)
- [Environment variables](#environment-variables)
- [`ROUTES`: multi-repo, multi-room](#routes--multi-repo-multi-room)
- [Glob syntax](#glob-syntax)
- [Skip reason codes](#skip-reason-codes)
- [Worked examples](#worked-examples)

## Precedence

```
environment  >  CONFIG_FILE (JSON, Node only)  >  built-in defaults
```

There are no CLI flags and no argv parser. The process takes no arguments.

| Target | Source of the environment | `CONFIG_FILE` | Notes |
|---|---|---|---|
| Cloudflare Workers | The `env` binding object: `vars` in `wrangler.jsonc`, plus `wrangler secret put` values | **Not available**: Workers has no filesystem. Put the same JSON in the `ROUTES` var instead | Every binding arrives as a **string**. `MAX_COMMITS_PER_PUSH` is `"15"`, not `15`. The config layer coerces explicitly; nothing downstream ever sees a raw binding |
| Node | `process.env`, seeded by `--env-file=.env` in dev and by the platform in production | Path to a JSON file; unset means no file is read | Same coercion path, so a bug in it fails on both targets at once |

`ROUTES` and `CONFIG_FILE` carry **the same JSON document with the same schema and the
same test suite**, one as a string, one as a file. If both are present, `ROUTES` wins
and boot logs `warn config_file_shadowed`.

## Boot validation

Validation runs **once**, against the merged object, and reports **every** problem at
once as a numbered list on stderr before exiting 1. Never a stack trace, never a partial
start, never a secret's value:

```
commit-relay: configuration is invalid. Fix these and restart.

  1. GITHUB_WEBHOOK_SECRET is not set.
     It is the "Secret" field on the GitHub webhook. Minimum 32 characters.
     Generate one with: openssl rand -hex 32
  ...

6 problems. See https://github.com/AKMofficial/commit-relay#configuration
```

| Rule | Detail |
|---|---|
| Trim before the empty check | A dashboard-pasted trailing newline is the real-world failure mode, not a missing variable |
| Never echo a secret's value | A published-literal error names the *published literal* it matched, which is public by definition. It never prints what the operator actually set |
| Report **all** problems | Six round trips of "fix one, redeploy, find the next" is the worst possible first run |
| Cross-field checks are part of validation | Named-variable existence, `ENRICH_DEADLINE_MS`, `REQUIRE_LINE_STATS` and `SHUTDOWN_DRAIN_MS` are boot rules, not runtime surprises |
| The docs URL is derived, not hardcoded | Read from `package.json` `repository.url`, so a fork prints its own URL with zero edits |

**Workers cannot exit.** Bindings are only reachable from a request, so validation is
lazy and memoized per isolate. On failure `/healthz` returns **500** and `/webhook`
returns **503**, and the `/healthz` body names every missing or invalid key at once,
names only:

```json
{"status":"config_invalid","missing":["BASECAMP_CHAT_ID","GITHUB_WEBHOOK_SECRET"]}
```

### Cross-field rules

| Rule | Failure message names |
|---|---|
| Every `githubTokenEnv`, `webhookSecretEnv` and `chatbotKeyEnv` must name a variable that is actually set | the variable and the route field that named it |
| A route's `webhookSecretEnv` value obeys the same 32-character floor and published-literal denylist as the global secret | the variable |
| `ENRICH_DEADLINE_MS` ≥ `GITHUB_TIMEOUT_MS * 3 + 8000` | both numbers and the value to raise it to |
| At least one complete target (`accountId`, `bucketId`, `chatId`, key) must resolve | each missing flat variable, and the route field that could have supplied it |
| `REQUIRE_LINE_STATS` may not be true while `FETCH_LINE_STATS` resolves to off | which of the two to change |
| `SHUTDOWN_DRAIN_MS`, when non-zero, must be ≥ `BASECAMP_TIMEOUT_MS` | both numbers |

### Published secret literals are refused

Boot refuses, for every secret-bearing field and regardless of `NODE_ENV`, any secret
literal published in this repository, the example files and the README quickstart.
Copying the development block into production is the most common self-host mistake.

## Environment variables

Secrets are marked in the **Secret** column. On Workers set those with
`wrangler secret put NAME` (never in `wrangler.jsonc` `vars`, which is committed); on
Node set them in the platform's variables UI (never in the repo).

### Basecamp

| Name | Secret | Required | Default | Description |
|---|---|---|---|---|
| `BASECAMP_LINES_URL` | **yes** | no | *(none)* | Paste the entire chatbot posting URL and commit-relay parses all four values out of it. Accepts `3.basecamp.com` or `3.basecampapi.com`, with or without the `.json` suffix. Wins over the four discrete variables when both are set. Removes the "which 7-digit number was which" failure mode entirely |
| `BASECAMP_ACCOUNT_ID` | no | **yes\*** | *(none)* | The number immediately after the host in any Basecamp URL. Validated as `^\d{1,20}$` |
| `BASECAMP_CHATBOT_KEY` | **yes** | **yes\*** | *(none)* | The token between `/integrations/` and `/buckets/`, 8-200 characters. **A bearer credential carried in a URL path**: it is never logged |
| `BASECAMP_CHATBOT_KEY_<SUFFIX>` | **yes** | no | *(none)* | Additional chatbot keys, referenced by a route target's `chatbotKeyEnv`. A chatbot lives in exactly one Campfire, so a second room means a second key. The suffix is free-form UPPER_SNAKE |
| `BASECAMP_BUCKET_ID` | no | **yes\*** | *(none)* | The number after `/buckets/`. A bucket is a project |
| `BASECAMP_CHAT_ID` | no | **yes\*** | *(none)* | The number after `/chats/`, i.e. the Campfire |
| `BASECAMP_API_BASE` | no | no | `https://3.basecampapi.com` | Override for tests and mocks; any absolute URL, plain http allowed. The API host is preferred over `3.basecamp.com` because it returns JSON error bodies rather than an HTML page |
| `BASECAMP_TIMEOUT_MS` | no | no | `10000` | Per POST, via `AbortSignal.timeout`. Range 1000-86400000 |
| `BASECAMP_MIN_INTERVAL_MS` | no | no | `250` | Floor between posts: 4 req/s against the observed 50-per-10-s ceiling |
| `BASECAMP_MAX_SLEEP_MS` | no | no | `30000` | Clamp on any `Retry-After` or `x-ratelimit` sleep. An unclamped remote value stalls every room on a single-consumer queue, and on Workers it would blow the 30-second `waitUntil` budget |
| `USER_AGENT` | no | no | `commit-relay/{version} (+{repository.url})`, both read from `package.json` | Sent to Basecamp and to GitHub. Basecamp documents a `400 Bad Request` without one; GitHub documents outright rejection. Derived at build time so a fork never ships an unresolved placeholder |

\* Required **unless** every matched route supplies a complete `target`, or
`BASECAMP_LINES_URL` is set. The boot error names which form is missing. Where these
values come from: [Basecamp setup](./basecamp-setup.md).

### GitHub

| Name | Secret | Required | Default | Description |
|---|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | **yes** | **yes** | *(none)* | Shared secret configured on every GitHub webhook. **Minimum 32 characters**, and boot refuses every published placeholder literal regardless of `NODE_ENV`. There is no unauthenticated mode and no skip flag. Generate with `openssl rand -hex 32` |
| `GITHUB_WEBHOOK_SECRET_<SUFFIX>` | **yes** | no | *(none)* | Additional webhook secrets, referenced by a route's `webhookSecretEnv`. The name must match `^GITHUB_WEBHOOK_SECRET_[A-Z0-9_]+$` |
| `GITHUB_TOKEN` | **yes** | no | *(none)* | Fine-grained PAT with **Contents: read** on the relayed repos. **Mandatory in practice for private repos**: unauthenticated requests get 404, not 403. ⚠️ GitHub Actions does not set this variable automatically, but many workflows map `github.token` into an env var of exactly this name, and a stray `.env` does the same: so `unset GITHUB_TOKEN` before running the smoke script, or CI authenticates with the Actions token instead of yours |
| `GITHUB_TOKEN_<SUFFIX>` | **yes** | no | *(none)* | Additional tokens, referenced by a route's `githubTokenEnv`. One fine-grained PAT cannot span two organizations. The name must match `^GITHUB_TOKEN_[A-Z0-9_]+$` |
| `GITHUB_API_BASE` | no | no | `https://api.github.com` | Global default for GitHub Enterprise Server. Override per route with `githubApiBase` so a GHES token is never transmitted to api.github.com |
| `GITHUB_WEB_ORIGIN` | no | no | `https://github.com` | The **web** origin, not the API one, and it must be `https://`. It is the sole allowlist every rendered `href` is checked against. Deliberately configuration, never payload-derived: an attacker who controls `compare` also controls `repository.html_url` |
| `GITHUB_CONCURRENCY` | no | no | `4` | Parallel stats lookups in the enricher's lookahead window. Range 1-32 |
| `GITHUB_TIMEOUT_MS` | no | no | `8000` | Per stats request |
| `GITHUB_STATS_MAX_BYTES` | no | no | `1048576` | Hard byte budget on the stats response. `GET /commits/{sha}` returns up to 300 `files[]` entries each carrying a `patch` string, so a vendored-dependency commit can return tens of MB. Above the budget the read is aborted and the commit resolves to `stats: null` |
| `FETCH_LINE_STATS` | no | no | `auto` | `auto` (on iff a token resolves) / `on` / `off` |
| `REQUIRE_LINE_STATS` | no | no | `false` | When true, boot fails if `FETCH_LINE_STATS` would resolve to off. Set it when every relayed repo is private and a blank Changes row is unacceptable |

### Behaviour

| Name | Secret | Required | Default | Description |
|---|---|---|---|---|
| `ROUTES` | no | no | *(none)* | The routing document as a single-line JSON string. Beats `CONFIG_FILE` |
| `CONFIG_FILE` | no | no | *(none)* | **Node only.** Path to the same JSON as a file. Unset means no file is read; there is no implicit `./config.json` |
| `BRANCHES` | no | no | `**` | Global branch allowlist, comma-separated globs. `**`, the default, means every branch. **Case-sensitive**: git refs are |
| `TAGS` | no | no | *(empty)* | Tag allowlist, matched against the ref with `refs/tags/` stripped. **Empty means no tag push is ever relayed.** Tags are never matched against `BRANCHES` |
| `REPO_ALLOWLIST` | no | no | *(empty)* | `owner/repo` globs, evaluated **before** routing. Empty accepts any correctly-signed repo and logs `warn repo_allowlist_open` once at boot. **Case-insensitive** |
| `SKIP_FORCED_PUSHES` | no | no | `false` | At the default, a `forced: true` push posts one rollup message labelled as a force push, never per-commit tables, because a rebase gives every commit a new SHA and SHA dedup cannot stop the double-announce. Set it to `true` to post nothing at all, logged `push_skipped { reason: "forced_push" }` |
| `SKIP_MERGE_COMMITS` | no | no | `true` | A merge commit's API diff is first-parent, i.e. the whole merged branch. With this on, a PR merge **still posts every branch commit**: only the merge commit itself is suppressed |
| `SKIP_NON_DISTINCT` | no | no | `true` | Drops commits delivered with `distinct: false` (already announced on another ref in this repo) |
| `IGNORE_AUTHORS` | no | no | *(empty)* | Globs matched against `sender.login`, `commit.author.username`, and `commit.author.email`. Not defaulted to any list: that would be a hardcoded assumption. `dependabot[bot],renovate[bot]` is suggested in a comment in the example files |
| `PR_ACTIONS` | no | no | `opened,closed,reopened,ready_for_review` | Which pull request actions post a message. Exact names from that list, not globs; anything else fails boot. `closed` covers both outcomes and renders as *merged* or *closed without merging* depending on `merged`. **Empty relays no pull request at all** |
| `PR_REVIEWS` | no | no | `true` | Post a message when a review is submitted: approved or changes requested. The Author row names the reviewer, and `IGNORE_AUTHORS` is matched against the reviewer. A `commented` review is never relayed: it fires for every review comment. Independent of `PR_ACTIONS`, because a review is a different GitHub event |
| `PR_SKIP_DRAFTS` | no | no | `true` | Suppress a draft pull request. `ready_for_review` is never suppressed by this: it is the moment the draft stops being one |
| `MAX_COMMITS_PER_PUSH` | no | no | `15` | Per-push cap on individually rendered commits, range 1-100. Set by Cloudflare's free-plan subrequest ceiling, not by taste |
| `SUBREQUEST_BUDGET` | no | no | `50` | Workers only: outbound calls allowed per invocation, range 0-10000000. Stats calls stop and posts defer to the queue before the platform's own `Too many subrequests` error fires. Ignored on Node; `0` disables |
| `COMMIT_BODY_MAX_CHARS` | no | no | `2000` | Commit message clip, counted in **Unicode code points**, applied at ingest and re-applied in the renderer |
| `CONTENT_MAX_BYTES` | no | no | `16384` | Ceiling on the assembled `content` string in UTF-8 bytes after escaping. **Basecamp documents no content limit; this is a self-imposed legibility budget** |
| `ENRICH_DEADLINE_MS` | no | no | `45000` | After this, a pending enrichment is aborted and force-promoted with `stats: null`. Boot rejects any value below `GITHUB_TIMEOUT_MS * 3 + 8000` |
| `POST_RETRY_BUDGET_MS` | no | no | `20000` | Total 5xx retry wall-time per message. 429 sleeps do **not** draw on it |
| `RATELIMIT_WAIT_BUDGET_MS` | no | no | `60000` | The separate budget 429 and `x-ratelimit` sleeps **do** draw on, per message. A 429 is the service pacing us correctly, not an error; when this budget is exhausted the message is re-queued rather than dropped |
| `MAX_QUEUE_DEPTH` | no | no | `500` | **Node only.** Maximum push jobs held in the in-process FIFO. Beyond it the newest job is refused with `warn queue_full` and the webhook still answers 202, because a 5xx would strand the delivery. Workers has a real queue and ignores this |
| `MAX_QUEUE_BYTES` | no | no | `33554432` | **Node only.** The same bound counted in bytes. Whichever ceiling is hit first refuses the job |
| `DEDUP_MAX_ENTRIES` | no | no | `10000` | Bound on the delivery-id dedup store. An LRU: a flood degrades dedup accuracy instead of memory |
| `DEDUP_TTL_HOURS` | no | no | `72` | How long a delivery id is remembered. GitHub's manual redelivery window is 3 days, so a redelivered push is recognised as a duplicate for exactly as long as it can be redelivered |
| `DROP_ALERT_WINDOW_MS` | no | no | `300000` | Rolling window over which dropped jobs are counted. One `error jobs_dropped` per window with the count, instead of one line per drop |
| `MAX_BODY_BYTES` | no | no | `26214400` | 25 MiB, just above GitHub's 25 MB payload cap. Enforced by a body limit **and** by a running counter over the request stream, so a chunked upload is cut off mid-flight rather than measured after buffering |
| `RATE_LIMIT_PER_MINUTE` | no | no | `120` | Per-IP cap on the webhook path, applied **before** HMAC. A global bucket at 100x this value runs alongside it, split by signature shape so unsigned traffic cannot deny a signed delivery |
| `TRUSTED_PROXY_HOPS` | no | no | `0` | **Node only** (Workers uses `CF-Connecting-IP`). How many `X-Forwarded-For` entries to skip **from the right**; `0` means use the socket address and ignore the header entirely. Range 0-8 |
| `WEBHOOK_PATH` | no | no | `/webhook` | Receiver path; must be an absolute path |
| `PORT` | no | no | `3000` | **Node only.** Injected by Railway and most PaaS platforms. Left unprefixed for exactly that reason |
| `SHUTDOWN_DRAIN_MS` | no | no | `20000` | **Node only.** SIGTERM drain budget before a forced exit, 0-600000. Must be less than the platform's own grace period |

#### What stops the same work being announced twice

Relaying every branch and every pull request means one change can reach the room
by more than one route. The defences are layered, and they differ in how far
they can be trusted.

Deterministic, stateless, and on by default. These behave identically on Workers
and on Node, and they are what actually stops the common case:

- `SKIP_NON_DISTINCT` drops the commits GitHub itself marks `distinct: false`,
  which is exactly what it marks on commits reappearing in a merge push after
  they were already delivered on the topic branch.
- `SKIP_MERGE_COMMITS` suppresses the merge commit itself, so the pull request
  message is the single announcement of the merge.

Best-effort, on top of those. The commit dedup key is
`repo|sha|bucketId|chatId` and deliberately omits the ref, so a repeated SHA is
skipped whatever branch carries it, for `DEDUP_TTL_HOURS`. On Node that is one
process and it holds. **On Workers the dedup map is per-isolate**, so two queue
messages handled by two isolates do not share it; there, the delivery-id dedup
is the protection that is robust, and it works because GitHub reuses the
delivery id on redelivery.

Two cases are not suppressed, by design rather than by oversight:

- A **squash merge** creates one genuinely new commit on the base branch, so it
  posts once alongside the pull request message. That is one extra line, and it
  is real information: the change landed on the default branch.
- A **rebase merge** of N commits rewrites all N SHAs, so those N post again on
  the base branch. No stateless relay can recognise them, and commit-relay keeps
  no database. Set `SKIP_FORCED_PUSHES`, narrow `BRANCHES`, or accept the echo.


`TRUSTED_PROXY_HOPS` must match the deployment, or the rate limiter becomes a no-op:

| Deployment | Value | Why |
|---|---|---|
| `docker run -p 3000:3000`, docker-compose, a VPS with no proxy | `0` | There is no `X-Forwarded-For`. Honouring one lets a flooder pick a fresh rate-limit bucket per request |
| Railway, Fly, Render | `1` | One trusted proxy appends the peer it observed; the rightmost entry is the trustworthy one |
| Cloudflare or another CDN in front of one of those | `2` | Two appenders |

When the header carries fewer entries than `TRUSTED_PROXY_HOPS`, the resolver falls back
to the socket address and logs `warn xff_hops_mismatch` rather than silently indexing
into attacker-supplied data.

### Observability

| Name | Secret | Required | Default | Description |
|---|---|---|---|---|
| `LOG_LEVEL` | no | no | `info` | `trace` / `debug` / `info` / `warn` / `error`. Every user-visible skip is `info`, never `debug` |
| `LOG_PAYLOADS` | no | no | `false` | Requires `LOG_LEVEL=trace` as well. Boot prints a warning: this logs private-repo commit messages and file paths |
| `HEALTH_TOKEN` | **yes** | no | *(unset, and `/health/detail` then 404s)* | At least 16 characters. Compared against the `X-Health-Token` header after an ASCII and length check, then with a constant-time compare |

**Naming.** The vendor prefixes (`GITHUB_`, `BASECAMP_`) name the *protocol*, not the
owner, and they are the public API surface under SemVer: renaming one is a major
release. `PORT` is deliberately unprefixed because platforms inject it.

### Where the non-obvious defaults come from

| Knob | Default | Limit it is derived from |
|---|---|---|
| `MAX_COMMITS_PER_PUSH` | 15 | Workers Free: 50 external subrequests per invocation, not raisable. N GitHub GETs + N Basecamp POSTs + one retry round = 45 at N=15, plus 1 rollup headroom and 4 in reserve. At N=17 it is 52 and the invocation dies |
| `SUBREQUEST_BUDGET` | 50 | Workers Free: 50 external subrequests per invocation. Raise it only on a Paid plan with `limits.subrequests` set in `wrangler.jsonc` |
| `GITHUB_CONCURRENCY` | 4 | Workers allows 6 connections simultaneously waiting for response headers; four leaves headroom for the in-flight Basecamp POST and one queue operation |
| `BASECAMP_MIN_INTERVAL_MS` | 250 | 50 requests per 10 seconds = 5 req/s; 250 ms gives 4 req/s, a 20% margin |
| `BASECAMP_MAX_SLEEP_MS` | 30000 | `ctx.waitUntil` extends execution up to 30 seconds after the response, shared across all `waitUntil` calls |
| `MAX_BODY_BYTES` | 26214400 | GitHub caps webhook payloads at 25 MB and does not deliver anything larger |
| `CONTENT_MAX_BYTES` | 16384 | A Cloudflare Queue message is capped at 128 KB and the job carries the commit message; Basecamp documents no content limit at all |
| `ENRICH_DEADLINE_MS` | 45000 | `GITHUB_TIMEOUT_MS * 3 + 8000` = 32000 is the enricher's worst case; 45000 leaves margin |
| `GITHUB_STATS_MAX_BYTES` | 1048576 | `GET /commits/{sha}` returns up to 300 `files[]` entries inline, each with a `patch` string; only `stats` is needed |
| `DEDUP_TTL_HOURS` | 72 | GitHub's manual redelivery window is 3 days, and there is no automatic redelivery at all |
| `SHUTDOWN_DRAIN_MS` | 20000 | Railway's SIGTERM grace period defaults to 0 seconds and must be raised above this value |

## The single-room quickstart needs no JSON

Four flat Basecamp variables plus the webhook secret and a token are a complete,
supported configuration. `ROUTES` ships documented and unused for everyone who does not
need it.

```dotenv
# Required. openssl rand -hex 32
GITHUB_WEBHOOK_SECRET=0f2b8c1d4a6e9f3b7c05d81a2e4f6b9c3d5a7e1f8b0c2d4a6e9f3b7c05d81a2e

# Required. All four are visible in the chatbot URL Basecamp shows you.
BASECAMP_ACCOUNT_ID=1234567
BASECAMP_CHATBOT_KEY=replace-me-with-your-chatbot-key
BASECAMP_BUCKET_ID=2345678
BASECAMP_CHAT_ID=7654321

# Optional but required in practice if any relayed repo is private.
GITHUB_TOKEN=

# Optional. Defaults shown.
BRANCHES=**
LOG_LEVEL=info
PORT=3000
```

Or, on either target, replace the four Basecamp lines with the one URL Basecamp actually
hands you:

```dotenv
BASECAMP_LINES_URL=https://3.basecampapi.com/1234567/integrations/YOUR_KEY/buckets/2345678/chats/7654321/lines.json
```

That form is preferred: three of the four discrete values are indistinguishable 7-digit
numbers, and swapping `BUCKET_ID` with `CHAT_ID` produces a 404 that reads like "wrong
project", the most common setup dead end. It also collapses all four values into a
single secret.

> The literals above are the ones this repository publishes, and boot **refuses** every
> one of them. They are shaped like real values so the example is copy-pasteable, and
> refused so a copy-paste cannot reach production.

### No Basecamp value may enter the repository

`wrangler.jsonc` is a **committed** file. Deploy from a public fork and everything in its
`vars` block is published. The ids are not credentials, the chatbot key is, but the
four values together are the complete posting URL, and publishing three quarters of the
address turns a future key leak into "a secret escaped and the target was already known".

| Value | Where it lives | Committed? |
|---|---|---|
| `BASECAMP_LINES_URL`, or the four discrete `BASECAMP_*` values | `wrangler secret put` / `.env` / platform variables | **Never** |
| `GITHUB_WEBHOOK_SECRET` | `wrangler secret put` / `.env` / platform variables | **Never** |
| `GITHUB_TOKEN` | `wrangler secret put` / `.env` / platform variables | **Never** |
| `BRANCHES`, `MAX_COMMITS_PER_PUSH`, `GITHUB_CONCURRENCY`, `LOG_LEVEL`, and every other behaviour knob | `wrangler.jsonc` `vars` | Yes, and a reader benefits from seeing them |

`vars` carries behaviour; `secret` carries identity. CI fails on any `BASECAMP_` key
inside a `vars` block.

N repositories can point at one deployment with the flat configuration. They all post
into one room, filtered by `BRANCHES`. `ROUTES` is only needed when different
repositories must reach different rooms.

## `ROUTES`: multi-repo, multi-room

Identical JSON in the `ROUTES` variable and in `CONFIG_FILE`. One schema, one parser,
one test suite.

```jsonc
{
  "defaults": {
    "branches": ["main"],
    "target": {
      "accountId": "1234567",
      "chatbotKeyEnv": "BASECAMP_CHATBOT_KEY",
      "bucketId": "2345678",
      "chatId": "7654321"
    }
  },
  "routes": [
    {
      // Repo 1 -> room A (the defaults room), extra release branches.
      "repo": "your-org/commit-relay",
      "branches": ["main", "release/*"]
    },
    {
      // Repo 2 -> room B. Shallow merge: accountId is inherited from
      // defaults.target, only bucketId/chatId/key are replaced.
      "repo": "your-org/infra-*",
      "branches": ["**"],
      // Substitute room B's OWN bucket and chat ids here. The ids below are
      // the placeholder pair used throughout these docs and are the same ones
      // in defaults.target, so copied verbatim this route posts to room A.
      "target": {
        "bucketId": "2345678",
        "chatId": "7654321",
        "chatbotKeyEnv": "BASECAMP_CHATBOT_KEY_INFRA"
      },
      "skipMergeCommits": false,
      "maxCommitsPerPush": 5
    },
    {
      // Repo 3 -> back to room A, but a different GitHub org needs its own PAT.
      "repo": "other-org/**",
      "branches": ["main"],
      "tags": ["v*"],
      "githubTokenEnv": "GITHUB_TOKEN_OTHERORG"
    }
  ],
  "fallthrough": "ignore"
}
```

### Semantics

| Field | Rule |
|---|---|
| `routes` | Evaluated **top to bottom, first match wins**. Order is the operator's tie-breaker; put specific repos above globs. Max 200 entries |
| `routes[].repo` | Glob against `owner/name`, **case-insensitive**. 1-200 characters |
| `routes[].branches` | Globs against the ref with `refs/heads/` stripped, **case-sensitive**. Omitted means inherit `defaults.branches`, which itself defaults to the `BRANCHES` variable |
| `routes[].prActions`, `routes[].prReviews`, `routes[].prSkipDrafts` | Per-route overrides of the three pull request variables. A pull request is matched against `branches` by its **base** branch |
| `routes[].tags` | Globs against the ref with `refs/tags/` stripped. Omitted means inherit `defaults.tags`, then `TAGS`, whose default is empty. **A non-empty list is the only thing that enables tag relaying**; there is no separate boolean. A tag ref is **never** matched against `branches` |
| `routes[].target` | **Shallow-merged over `defaults.target`**, which is itself shallow-merged over the flat `BASECAMP_*` variables. A route may override only `chatId` and inherit the rest. Merge is one level deep |
| `chatbotKey` vs `chatbotKeyEnv` | `chatbotKeyEnv` names a variable holding the key and is what `config.example.json` uses. Inline `chatbotKey` still works but logs `warn chatbotkey_inline_in_config` at boot: it puts an unexpiring, unrotatable room-posting credential into a file. Setting both is a schema error |
| `routes[].githubTokenEnv` | Names that route's token variable; must match `^GITHUB_TOKEN_[A-Z0-9_]+$`. Boot **fails** if it is unset. There is deliberately no fallback to the global `GITHUB_TOKEN`: a typo must not silently defeat the isolation the field exists to provide |
| `routes[].githubApiBase` | Per-route API host, `https://` only, defaulting to `GITHUB_API_BASE`. Required when one deployment relays both github.com and a GHES instance |
| `routes[].webhookSecretEnv` | Names that route's webhook secret; must match `^GITHUB_WEBHOOK_SECRET_[A-Z0-9_]+$`. Omitted means the global `GITHUB_WEBHOOK_SECRET` verifies that route. **Required in practice for any multi-room deployment spanning trust levels**, because one shared secret lets any repo that holds it forge a push for any other route's repo. The signature is verified against the secret of the route matched by `repository.full_name` |
| Per-route overrides | `skipMergeCommits`, `skipForcedPushes`, `skipNonDistinct`, `ignoreAuthors`, `maxCommitsPerPush` (1-100) each fall back to the global variable when omitted |
| `fallthrough` | `"ignore"` (default) drops an unmatched repo with an `info` log. `"defaults"` sends it to `defaults.target`, still filtered by `defaults.branches` and still subject to `REPO_ALLOWLIST`, which is evaluated **before** routing |
| No match and no default target | Drop, `info push_skipped { reason: "no_route" }` |
| Unknown keys | Rejected. The schema is strict, so a typo'd `chat_id` is a boot error rather than a silently ignored field. The *webhook payload* schema is the opposite: lenient by design |

**One chatbot key per room is unavoidable.** A Basecamp chatbot lives in one Campfire and
its key is minted per chatbot, so a two-room setup needs two keys. This is the most
confusing part of multi-room configuration.

### Effective-value precedence, per setting

| Setting | Resolved from, first that is present |
|---|---|
| Branch list | `routes[i].branches` → `defaults.branches` → `BRANCHES` |
| Tag list | `routes[i].tags` → `defaults.tags` → `TAGS` |
| Each target field | `routes[i].target.<field>` → `defaults.target.<field>` → the flat `BASECAMP_*` variable (or the value parsed out of `BASECAMP_LINES_URL`) |
| Token | `routes[i].githubTokenEnv` → `GITHUB_TOKEN` (only when the route declares no `githubTokenEnv`) |
| Webhook secret | `routes[i].webhookSecretEnv` → `GITHUB_WEBHOOK_SECRET` |
| API base | `routes[i].githubApiBase` → `GITHUB_API_BASE` |
| `skipMergeCommits` / `skipForcedPushes` / `skipNonDistinct` / `ignoreAuthors` / `maxCommitsPerPush` | the route field → the matching global variable |

## Glob syntax

Matching is segment-wise, with no regex translation.

| Token | Matches |
|---|---|
| `*` | Zero or more characters **within one `/`-separated segment** |
| `?` | Exactly one character, not `/` |
| `**` | Zero or more whole segments, including none. `**` alone matches everything |
| anything else | Itself, literally. There are no character classes, no braces, no negation |

| Rule | Value | Reason |
|---|---|---|
| Branch and tag matching | **Case-sensitive** | Git refs are case-sensitive. `Main` and `main` are different branches |
| Repo matching | **Case-insensitive** | GitHub repository names are not case-sensitive |
| Anchoring | Full-string | `main` does not match `main-backup` |
| Max pattern length | 200 characters | Rejected at boot, not at match time |
| Max `**` tokens per pattern | 2 | `release/**/**/**/*` is a boot error. The matcher is linear, but the guard is cheap and documents the intent |
| Max subject length | 512 bytes | A longer ref is rejected with `skip_ref_too_long`. The subject is payload-controlled; the pattern is not |
| Compilation | Once, at boot, from config only | No payload value is ever compiled into a matcher |

| Pattern | Matches | Does not match |
|---|---|---|
| `main` | `main` | `main-backup`, `Main`, `feature/main` |
| `release/*` | `release/2.0`, `release/beta` | `release`, `release/2.0/rc1` |
| `**` | every branch | N/A |
| `feature/**` | `feature/x`, `feature/x/y`, `feature` | `feat/x` |
| `v?.0` | `v1.0`, `v2.0` | `v10.0` |
| `AKMofficial/*` | `AKMofficial/commit-relay`, `AKMOFFICIAL/commit-relay` | `other-org/commit-relay` |
| `other-org/**` | `other-org/commit-relay` | `AKMofficial/commit-relay` |

### Ref classification happens first

| Ref | Classified as | Matched against |
|---|---|---|
| `refs/heads/main` | branch `main` | `branches` |
| `refs/heads/release/2.0` | branch `release/2.0` | `branches` |
| `refs/tags/v0.1.0` | tag `v0.1.0` | `tags`, and only if `tags` is non-empty |
| anything else | unknown | nothing: dropped with `skip_not_a_ref` |

A tag is **never** matched against `branches`. Matching `refs/tags/v0.1.0` against a
branch list is the bug that makes a populated `TAGS` appear to do nothing.

## Skip reason codes

Every skip decision is logged at `info`, never `debug`, "my push did not appear" is the
number one support report, and the answer has to be in the default log level:

```json
{"t":"2026-09-01T09:14:22.104Z","lvl":"info","evt":"push_skipped","svc":"commit-relay","ver":"0.1.0","tgt":"workers",
 "reason":"branch_not_allowed","repo":"your-org/commit-relay","ref":"refs/heads/feature/spike",
 "refKind":"branch","refName":"feature/spike","matchedRoute":"your-org/*",
 "patternsTried":["main","release/*"],"deliveryId":"5f8a...","commits":3}
```

The two fields that matter are `matchedRoute` and `patternsTried`. Without them the
operator has to reconstruct the merge of `BRANCHES`, `defaults.branches`, and
`routes[].branches` from three places by hand.

`reason` is a **closed vocabulary**. These sixteen strings are the whole set; a skip
that does not fit one of them is a missing code, not a free-text field. Filter reasons
carry no `skip_` prefix, the `evt` is already `push_skipped`. The two malformed-ref
codes keep theirs because they are rejections of the ref itself rather than a policy
decision about it.

| `reason` | Emitted when |
|---|---|
| `repo_not_allowed` | `REPO_ALLOWLIST` is non-empty and `repository.full_name` matches none of it |
| `no_route` | No route matched and `fallthrough` is `"ignore"`, or no default target resolves |
| `skip_not_a_ref` | `ref` is neither `refs/heads/*` nor `refs/tags/*` |
| `skip_ref_too_long` | `ref` exceeds the 512-byte subject cap |
| `branch_not_allowed` | A branch ref matched no pattern in the effective `branches` list |
| `tags_disabled` | A tag ref arrived and the effective `tags` list is empty |
| `tag_not_allowed` | A tag ref matched no pattern in a non-empty `tags` list |
| `branch_deleted` | `deleted: true`: the ref is gone, there is nothing to narrate |
| `no_commits` | `commits: []` after classification, with no rollup trigger |
| `forced_push` | `forced: true` **and** `SKIP_FORCED_PUSHES=true`. At the default `false` a forced push is **not** skipped: it posts one rollup labelled as a force push and emits no `push_skipped` at all |
| `merge_commit` | Per-commit: `parents.length > 1` and `SKIP_MERGE_COMMITS` is on |
| `non_distinct` | Per-commit: `distinct: false` and `SKIP_NON_DISTINCT` is on |
| `author_ignored` | Per-commit: an `IGNORE_AUTHORS` glob matched the sender login, author username, or author email. For a pull request, the pull request author |
| `pr_action_ignored` | The action is outside `PR_ACTIONS`, or a review arrived with `PR_REVIEWS` off, or the review state is one this version does not render. An action this version can never render (`synchronize`, `labeled`, an `edited` review, and so on) is logged at `debug` as `pull_request_action_ignored` instead and does not move `skippedTotal` |
| `pr_draft` | A draft pull request, with `PR_SKIP_DRAFTS` on. `ready_for_review` is never suppressed by this, and neither is a review on a draft |
| `pr_base_not_allowed` | The pull request's **base** branch failed the branch allowlist. Distinct from `branch_not_allowed`, which would read as a push |

## Worked examples

### 1. One repo, one room, default branch only

```dotenv
GITHUB_WEBHOOK_SECRET=<openssl rand -hex 32>
BASECAMP_LINES_URL=https://3.basecampapi.com/1234567/integrations/YOUR_KEY/buckets/2345678/chats/7654321/lines.json
```

`BRANCHES` defaults to `**`, so a push to `feature/spike` is relayed like any
other, and each commit table names the branch it landed on. Narrow it to
`BRANCHES=main` and the same push instead logs
`push_skipped { reason: "branch_not_allowed", patternsTried: ["main"] }` and nothing
else happens. No `ROUTES` document is involved.

### 2. Add release branches and relay tags

```dotenv
BRANCHES=main,release/*
TAGS=v*
```

`refs/heads/release/2.0` now matches; `refs/heads/release/2.0/rc1` still does not,
because `*` stays inside one segment, use `release/**` for that.
`refs/tags/v0.1.0` is relayed only because `TAGS` is non-empty; with `TAGS` unset the
same push logs `tags_disabled`.

### 3. Two rooms, two chatbot keys

Secrets:

```bash
wrangler secret put BASECAMP_LINES_URL
wrangler secret put BASECAMP_CHATBOT_KEY_INFRA
wrangler secret put GITHUB_WEBHOOK_SECRET
```

`ROUTES` (one line in the variable; shown wrapped):

```json
{"defaults":{"branches":["main"]},
 "routes":[{"repo":"your-org/commit-relay"},
           {"repo":"your-org/infra-*","branches":["**"],
            "target":{"chatId":"7654321","chatbotKeyEnv":"BASECAMP_CHATBOT_KEY_INFRA"}}],
 "fallthrough":"ignore"}
```

The second route inherits `accountId` and `bucketId` from the flat values parsed out of
`BASECAMP_LINES_URL` and replaces only `chatId` and the key. A push from a repo matching
neither pattern is dropped with `no_route`.

⚠️ `7654321` above is the placeholder chat id these docs also use for the default room,
so the snippet as printed routes both repos to the **same** room. Replace it with the
second room's own chat id, and, if that room lives in a different Basecamp project,
its `bucketId` too, read out of that room's own posting URL
([Basecamp setup](./basecamp-setup.md)). The docs carry one placeholder chat id because
only three ids are sanctioned; a working two-room config needs two real ones.

### 4. Two GitHub organizations, isolated credentials

```json
{"routes":[{"repo":"your-org/**"},
           {"repo":"other-org/**","githubTokenEnv":"GITHUB_TOKEN_OTHERORG",
            "webhookSecretEnv":"GITHUB_WEBHOOK_SECRET_OTHERORG"}]}
```

Both named variables must be set or boot fails, naming them. `other-org` pushes are
verified against their own webhook secret, so a leak of one org's secret cannot forge a
push for the other. One fine-grained PAT cannot span two organizations, which is why the
token is per route.

### 5. GitHub Enterprise Server alongside github.com

```json
{"routes":[{"repo":"your-org/**","githubApiBase":"https://ghe.example.com/api/v3",
            "githubTokenEnv":"GITHUB_TOKEN_GHES"}]}
```

Set `GITHUB_WEB_ORIGIN=https://ghe.example.com` as well: it is the allowlist every
rendered link is checked against, and a link to a host that is not on it is dropped.

### 6. Quiet a bot and stop double-announcing

```dotenv
IGNORE_AUTHORS=dependabot[bot],*@noreply.github.com
SKIP_NON_DISTINCT=true
SKIP_MERGE_COMMITS=true
```

Each ignored commit logs `author_ignored`; each already-announced commit logs
`non_distinct`; the merge commit itself logs `merge_commit` while the branch commits it
merges are still posted individually.

### 7. Private repos, and a blank Changes row is unacceptable

```dotenv
GITHUB_TOKEN=<fine-grained PAT with Contents: read>
FETCH_LINE_STATS=on
REQUIRE_LINE_STATS=true
```

With `REQUIRE_LINE_STATS=true`, boot fails if `FETCH_LINE_STATS` would resolve to off, 
including the `auto` case where no token is set. Without a token, unauthenticated commit
lookups on a private repo return 404, not 403, and the Changes row renders `N/A`.
