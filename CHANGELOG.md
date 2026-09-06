# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
