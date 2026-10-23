# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-23

### Security

- The container image runs Node 24.22.1 (from 24.21.0), which carries the Node.js
  October 2026 security release: four high-severity fixes covering TLS server
  identity checks for non-canonical IP hosts, a Brotli decoder overflow, and DNS
  name truncation at a NUL byte. The Workers target does not run Node and is
  unaffected.

## [0.1.0] - 2026-10-16

First public release.

### Added

- GitHub `push`, `pull_request` and `pull_request_review` webhook receiver:
  HMAC-SHA256 verification over the raw unparsed request bytes using
  `crypto.subtle.verify`, with a `sha256=<64 hex>` shape gate and no bypass at
  any log level.
- One Basecamp Campfire chat line per commit, rendered as a six-row HTML table:
  repository, author, file count, `+/- ` line counts, branch, and the complete
  commit message, followed after a blank line by a single link to the commit on
  GitHub. Commit messages up to `COMMIT_BODY_MAX_CHARS` (default 4000) fit within
  `CONTENT_MAX_BYTES` (default 32768) without clipping.
- A force push links to the new head commit, and its Files row reads N/A, since
  the old and rewritten history share no commits to compare.
- The same table for a pull request opened, merged, closed, reopened, marked
  ready for review, or reviewed. Line counts come from the payload, so a pull
  request costs no GitHub API call. Routed by base branch, with `PR_ACTIONS`,
  `PR_REVIEWS` and `PR_SKIP_DRAFTS`.
- Per-commit `+/-` line counts from one GitHub REST call per commit, read against
  a hard byte budget and degraded to an empty cell rather than failing the message.
- Noise filters, on by default: non-distinct commits, merge commits, bot authors,
  tag pushes, and branch create or delete.
- Text safety: control-character and bidi stripping, NFC normalisation, code-point
  truncation, HTML escaping of every payload-derived value, and `https:`-plus-origin
  validation on every rendered link.
- Routing: multiple repositories to multiple Campfire chats, with per-route branch
  glob filters, per-route GitHub token variables, and per-route webhook secrets,
  configured through `ROUTES` as one JSON line or `CONFIG_FILE` on Node.
- Delivery: bounded in-memory queue on the Node target, Cloudflare Queues with a
  dead-letter queue on the Workers target, jittered capped backoff, and dedup on
  `(repo, sha, bucketId, chatId)`. On Workers, a failed re-enqueue of a deferred
  job logs `error queue_resend_failed` and retries the message; on Node, a crash or
  shutdown logs `jobs_lost` with the queued shas and delivery ids.
- Cloudflare Workers target and a Node 24 + Docker target from one platform-pure
  core, kept portable by two typecheck configurations. A Deploy to Cloudflare
  button that asks for three values (`BASECAMP_LINES_URL`, `GITHUB_WEBHOOK_SECRET`,
  `GITHUB_TOKEN`), and a `railway.json` with `overlapSeconds` 0 so a redeploy never
  runs two processes at once.
- `/healthz` with optional token gating, reporting queue and delivery gauges and
  turning unhealthy on a terminal Basecamp status or recent drops. Basecamp health
  is tracked per room, and the next successful post to a room clears its terminal
  status. NDJSON structured logs with shape-based secret redaction applied to the
  serialized line.
- Backpressure and abuse limits: request body limit, in-flight byte semaphore,
  maximum commits per push, queue depth and byte ceilings, outbound timeouts, and
  per-IP plus global token buckets. Both tokens are refunded once a delivery passes
  HMAC, so `RATE_LIMIT_PER_MINUTE` only charges requests that fail verification.

### Security

- Config validation rejects: a chatbot key (flat, decoded from
  `BASECAMP_LINES_URL`, inline, or via `chatbotKeyEnv`) outside `[A-Za-z0-9_-]+`; a
  `REPO_ALLOWLIST` that is set but lists nothing (such as `,`), while unset allows
  every repo; a route that an earlier route always shadows, naming both; a route's
  `webhookSecretEnv` value over 1024 characters or equal to `GITHUB_WEBHOOK_SECRET`
  or another route's secret; a route's `githubApiBase` carrying credentials.
- The per-IP webhook rate limit keys IPv6 clients by their `/64` prefix, so one
  host rotating addresses in its prefix shares one bucket.
- Trusted private peers for forwarded-header handling include `100.64.0.0/10`,
  `169.254.0.0/16`, `fe80::/10` and an exact `fc00::/7` check.
- Outbound calls to Basecamp and GitHub do not follow redirects. A 3xx from
  Basecamp is a fatal post; from GitHub it yields empty line stats, not retried.
- The Basecamp response body is read up to 4 KiB, and a body error after a 201
  does not cause a duplicate post.
- `x-ratelimit` pacing between posts in one push draws on
  `RATELIMIT_WAIT_BUDGET_MS`; once spent, only the static interval applies.
- With invalid config, `/health/detail` refuses a `HEALTH_TOKEN` that fails the
  16-256 printable-ASCII rule.
- `rate_limited`, `webhook_bad_content_type`, `xff_hops_mismatch` and
  `health_detail_unauthorized` log lines are throttled to one per event per 60 s.
- Queued push jobs with `resumeAtSeq` beyond the commit count are rejected.
- Delivery-id dedup is scoped to the repository, so a sender on one route cannot
  mark another route's delivery completed.
- On Workers, queue messages consumed while the config is invalid are retried every
  5 minutes and reach the DLQ instead of being acked and lost.
- A 401 from GitHub on a request that carried a token logs
  `error github_token_rejected`, once per repo per hour.
- Supply-chain hardening: pnpm `minimumReleaseAge` 7 days, `trustPolicy`
  no-downgrade, `blockExoticSubdeps`, a 7-day Dependabot cooldown, a
  dependency-review CI job, and gitleaks scanning test files with only the
  invented test credentials allowlisted. Release images are multi-arch
  (amd64, arm64) with SBOM and signed SLSA build provenance.

## Public API surface

What counts as a breaking change, so nobody has to guess:

| Surface | Change class |
|---|---|
| An environment variable's name or meaning | Renaming or removing → **major**. Adding one with a safe default → **minor**. |
| An HTTP route or its status codes | Changing → **major**. |
| The container's runtime interface (entrypoint, port, user, healthcheck path) | Changing → **major**. |
| A `wrangler.jsonc` binding name (`COMMITS`, the DLQ) | Renaming → **major**; an operator's provisioned resources break. |
| The rendered table's row order or layout | **Minor**: it is output, not API. |
| A default value changing | **Minor**, and always called out under `Changed`. |

[Unreleased]: https://github.com/AKMofficial/commit-relay/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/AKMofficial/commit-relay/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/AKMofficial/commit-relay/releases/tag/v0.1.0
