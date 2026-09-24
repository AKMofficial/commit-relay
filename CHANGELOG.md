# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Default `COMMIT_BODY_MAX_CHARS` raised from 2000 to 4000 and `CONTENT_MAX_BYTES`
  from 16384 to 32768, so long commit messages are no longer clipped.
- `railway.json` sets `overlapSeconds` to 0, so a redeploy never runs two processes
  at once. A delivery during the switchover fails and can be redelivered.
- The README is rewritten in plain language around what a new user needs: the three
  values, the Deploy button, adding a repository, common settings, how it works, top
  fixes and the FAQ. The full troubleshooting table moved to `docs/troubleshooting.md`;
  the settings reference stays in `docs/configuration.md`.
- `.dev.vars.example` lists only `BASECAMP_LINES_URL`, `GITHUB_WEBHOOK_SECRET` and
  `GITHUB_TOKEN`, so the Deploy to Cloudflare setup page asks for three values instead
  of every setting. `.env.example` still lists them all.

### Fixed

- `/healthz` Basecamp health is tracked per room: the next successful post to a room
  clears its terminal status, so repairing one route no longer needs a restart, and
  one bad route no longer hides that the others recovered.
- A delivery that passes HMAC now gets its per-IP rate-limit token back as well, so
  `RATE_LIMIT_PER_MINUTE` only charges requests that fail verification. A busy org
  hook could otherwise 429 genuine deliveries from one GitHub sender address.
- On Workers, a failed re-enqueue of a deferred job logs `error queue_resend_failed` and
  retries the message instead of throwing unacked.
- On Node, a crash logs `jobs_lost` with the queued shas and delivery ids, as a normal
  shutdown already did.
- Docs corrected where they contradicted the code: the `BRANCHES` default (`**`, not
  `main`), queue overflow (503, not 202), the Node wait-budget behaviour, pull request
  support in the FAQ, the `:0.1` quickstart tag, six invariant rules, and where
  `USE_COLSPAN` lives.

### Security

- New config validation errors, which can stop a previously booting config: a chatbot
  key (flat, decoded from `BASECAMP_LINES_URL`, inline, or via `chatbotKeyEnv`) must
  match `[A-Za-z0-9_-]+`; a `REPO_ALLOWLIST` that is set but lists nothing (such as
  `,`) is rejected, while unset still allows every repo; a route that an earlier route
  always shadows is rejected, naming both; a route's `webhookSecretEnv` value is capped
  at 1024 characters; a route's `githubApiBase` is trimmed and may not carry
  credentials.
- The per-IP webhook rate limit now keys IPv6 clients by their `/64` prefix, so one
  host rotating addresses in its prefix shares one bucket. IPv4 is unchanged.
- Trusted private peers for forwarded-header handling now include `100.64.0.0/10`,
  `169.254.0.0/16` and `fe80::/10`; the `fc00::/7` check is exact.
- Outbound calls to Basecamp and GitHub no longer follow redirects. A 3xx from
  Basecamp is a fatal post; from GitHub it yields empty line stats, not retried.
- The Basecamp response body is read up to 4 KiB, and a body error after a 201 no
  longer causes a duplicate post.
- `x-ratelimit` pacing between posts in one push draws on
  `RATELIMIT_WAIT_BUDGET_MS`; once spent, only the static interval applies.
- With invalid config, `/health/detail` refuses a `HEALTH_TOKEN` that fails the
  16-256 printable-ASCII rule.
- `rate_limited`, `webhook_bad_content_type`, `xff_hops_mismatch` and the new
  `health_detail_unauthorized` log lines are throttled to one per event per 60 s.
- Queued push jobs with `resumeAtSeq` beyond the commit count are rejected.
- A route's `webhookSecretEnv` holding the same value as `GITHUB_WEBHOOK_SECRET` or
  another route's secret is a validation error, since one signature would verify for both.
- Delivery-id dedup is scoped to the repository, so a sender on one route cannot mark
  another route's delivery completed.
- On Workers, queue messages consumed while the config is invalid are retried every
  5 minutes and reach the DLQ, instead of being acked and lost.
- A 401 from GitHub on a request that carried a token logs `error github_token_rejected`,
  once per repo per hour.
- gitleaks now scans test files; only the invented test credentials are allowlisted.

## [0.1.0] - 2026-09-06

### Added

- GitHub `push`, `pull_request` and `pull_request_review` webhook receiver:
  HMAC-SHA256 verification over the raw unparsed request bytes using
  `crypto.subtle.verify`, with a `sha256=<64 hex>` shape gate and no bypass at
  any log level.
- One Basecamp Campfire chat line per commit, rendered as a six-row HTML table:
  repository, author, file count, `+/- ` line counts, branch, and the complete
  commit message, followed by a single link to the commit on GitHub.
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
  `(repo, sha, bucketId, chatId)`.
- Cloudflare Workers target and a Node 24 + Docker target from one platform-pure
  core, kept portable by two typecheck configurations.
- `/healthz` with optional token gating, reporting queue and delivery gauges and
  turning unhealthy on a terminal Basecamp status or recent drops, plus NDJSON
  structured logs with shape-based secret redaction applied to the serialized line.
- Backpressure and abuse limits: request body limit, in-flight byte semaphore,
  maximum commits per push, queue depth and byte ceilings, outbound timeouts, and
  per-IP plus global token buckets whose global token is refunded once a delivery
  passes HMAC.

### Security

- Supply-chain hardening: pnpm `minimumReleaseAge` 7 days, `trustPolicy`
  no-downgrade, `blockExoticSubdeps`, a 7-day Dependabot cooldown, and a
  dependency-review CI job.

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

[Unreleased]: https://github.com/AKMofficial/commit-relay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AKMofficial/commit-relay/releases/tag/v0.1.0
