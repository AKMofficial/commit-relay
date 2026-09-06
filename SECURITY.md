# Security Policy

## Supported versions

Only the latest minor of the latest major receives security fixes. There are no
long-term-support branches: this is a small service and upgrading is a container
tag bump or a `wrangler deploy` from a fresh clone.

| Version | Supported |
|---|---|
| Latest minor of the latest major | ✅ |
| Any earlier minor | ❌: upgrade to the latest minor |
| Any earlier major | ❌ |

## Reporting a vulnerability

Report privately via [Report a vulnerability](https://github.com/AKMofficial/commit-relay/security/advisories/new)
([how private reporting works](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)),
never a public issue.

Include the target (Cloudflare Workers, Docker, Railway, or Node from source), the
version or commit SHA, and the smallest payload or configuration that reproduces the
problem, with every token and secret removed.

- **Acknowledgement:** within 5 business days.
- **Triage decision:** within 30 days: accepted with a planned fix, accepted as a
  documented residual risk, or declined with a reason.
- **Disclosure:** coordinated, 90 days by default from the acknowledgement, earlier if
  a fix ships sooner and later only by mutual agreement. Reporters are credited in the
  advisory unless they ask not to be.

## Threat model summary

The full reasoning lives in the design document; this is what the service actually
defends against and how.

| Threat | Mitigation |
|---|---|
| **Forged webhook**: anyone who learns the public URL POSTs a crafted `push` payload | HMAC-SHA256 over the raw unparsed bytes, verified with `crypto.subtle.verify`. A `^sha256=[0-9a-f]{64}$` shape gate rejects junk and the legacy SHA-1 header before any crypto runs. No skip flag exists at any log level. A missing or empty `GITHUB_WEBHOOK_SECRET` is a fatal boot error on Node and a `500` from `/healthz` on Workers, never a bypass. |
| **Cross-repo forgery with a shared secret**: one secret pasted into many repository hooks proves only that *a* holder of the secret sent this | Optional per-route `webhookSecretEnv`. When set, the handler records which secret matched and rejects `401` if that secret's route is not the route `repository.full_name` resolves to. Required for any multi-room `ROUTES` deployment spanning trust levels. |
| **Timing attack on signature comparison** | Constant-time by construction: `crypto.subtle.verify` instead of sign-then-compare. A grep invariant forbids `===`/`!==` where either operand's identifier contains `token`, `secret`, `digest`, or `signature`. |
| **Replay**: GitHub's signature carries no timestamp | TLS prevents capture. `X-GitHub-Delivery` is *not* covered by the HMAC and is therefore not a replay control. Dedup keys on `(repo, sha, bucketId, chatId)`, derived entirely from signed bytes. No freshness window ships; the worst case of a successful replay is a duplicate chat line. |
| **HTML injection into a private chat room**: a contributor writes markup into a commit subject, a branch name, or `git config user.name` | Fixed render order: sanitize → truncate the source → escape (`& < > " '`) → insert `<br>`. Every payload-derived value passes `escapeHtml` with no exception, enforced by a grep invariant over `src/render/`. |
| **Bidi / invisible-character spoofing** | `sanitizeText()` runs on every payload-derived string: repo name, author, branch, ref, message: stripping C0/C1, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF, then `normalize('NFC')`. Truncation is by code point, never `.length`. |
| **Link injection via an attribute** | Every value entering an `href` also passes `safeUrl()`: scheme must be `https:` and the origin must equal the configured GitHub web origin. On failure the value renders as escaped plain text with no link. |
| **Secret leakage into logs**: `BASECAMP_CHATBOT_KEY` is a URL path segment, so logging a URL leaks it | Shape-based redaction applied to the serialized NDJSON string inside the logger, so no field name can bypass it. |
| **Secret leakage into error bodies** | `sanitizeBasecampError()` rebuilds the message from `{status, statusText}` rather than wrapping the original; response bodies are drained but never embedded. |
| **Over-scoped GitHub token** | Documented as a fine-grained PAT with **Contents: read** on exactly the relayed repositories. Per-route `githubTokenEnv` never falls back to the global token, and naming an unset variable is a boot error rather than a silent downgrade. Per-route `githubApiBase` keeps a GHES PAT off `api.github.com`. |
| **Denial of service** | A body limit just above GitHub's 25 MB cap, a running byte counter that cancels chunked bodies, a process-wide in-flight-bytes semaphore on Node, `per_page=1` plus a hard byte budget on the GitHub commit fetch, and bounded queue depth, queue bytes, dedup entries, and commits per push. |
| **ReDoS in glob matching**: the pattern is config-controlled but the subject is payload-controlled | Patterns compile once at boot with a length cap and a limit of two `**` tokens; the translation emits linear-time constructs only; refs longer than 512 bytes are rejected before matching. |
| **Dependency supply chain** | Two runtime dependencies, both with no transitive tree, asserted in CI. `packageManager` pinned with its integrity hash. `--frozen-lockfile --ignore-scripts` on every install, a blocking `pnpm audit --audit-level=high`, every action pinned to a 40-hex SHA, `persist-credentials: false` on every checkout, `contents: read` by default, and never `pull_request_target`. |
| **Leaking the operator's private config into a public fork** | `.gitignore` covers `.env*`, `.dev.vars*`, and `*config*.json` with explicit re-includes for the examples; `.dockerignore` is asserted in CI to be a superset of those entries; gitleaks runs with full history and a custom chatbot-key rule; `scripts/check-placeholders.sh` greps for shapes, not brand strings. |

## Operator responsibilities

These are not technical controls this service can provide. They are yours.

- **Private-repo commit messages become readable by everyone in the Campfire**, including
  people added to the room later. The chat room's membership is almost always wider than
  the repository's. Route private repositories only to rooms whose current *and future*
  membership you accept, and treat a commit subject as public to that room.
- **Keep the secrets out of the repository.** `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, and
  every `BASECAMP_*` value are Workers secrets or container environment variables, never
  committed. `wrangler.jsonc` is public in a fork, so nothing Basecamp-related belongs in
  its `vars` block.
- **Generate the webhook secret.** At least 32 characters from a CSPRNG
  (`openssl rand -hex 32`). The example literals are on a boot denylist.
- **Scope the GitHub token** to a fine-grained PAT with Contents: read on exactly the
  repositories you relay, and rotate it on the schedule your organization uses.
- **Use per-route secrets** for any multi-room deployment that spans trust levels.
- **Serve over TLS only** and keep the receiver's URL out of public places; the URL is not
  a secret, but obscurity costs nothing.
- **Protect `/healthz`** with `HEALTH_TOKEN` if the deployment's health output would tell a
  stranger anything about your configuration.
- **Watch your logs' destination.** Redaction is shape-based and good, but a log sink with
  wider access than the chat room widens the blast radius of everything above.

## Accepted risks

Documented, not fixed. Each is a deliberate decision.

- **Delivery is not exactly-once.** The contract, verbatim:

  > At-most-once across process death on the Node target; at-least-once across queue
  > redelivery on the Workers target; at-least-once across transport timeouts and 429
  > retries on both. Exactly-once is not offered.

  On the Node target an OOM kill, a segfault, or a platform-level kill loses in-flight
  messages permanently: GitHub does not auto-retry, and manual Redeliver only works for
  3 days.
- **No replay freshness window.** A captured, signed request stays replayable. Clock skew
  and legitimately old commits would trip a window, and the worst case of a replay is a
  duplicate chat line.
- **Cross-push ordering is not guaranteed** on either target. Intra-push ordering is.
- **Basecamp's own sanitizer is defence in depth, not the control.** The escaping in this
  service is the control; a change on Basecamp's side is not assumed to protect anyone.
- **The chatbot key is a bearer credential in a URL path.** That is Basecamp's integration
  design, not a choice this project makes. Redaction covers the logs; the key's presence
  in the request line is inherent.

## Supply chain controls

- 7-day `minimumReleaseAge` quarantine on every dependency, with `minimumReleaseAgeStrict: false` as the fallback.
- `trustPolicy: no-downgrade`.
- `blockExoticSubdeps: true`.
- `strictDepBuilds: true` with the `allowBuilds` allowlist.
- `--frozen-lockfile --ignore-scripts` on every install.
- `packageManager` pinned with its integrity hash and installed through corepack.
- Dependabot 7-day cooldown on npm, github-actions, and docker updates.
- Every action pinned to a 40-hex SHA with `persist-credentials: false` on every checkout.
- `dependency-review` on pull requests.
- gitleaks over full history.
- Blocking `pnpm audit --audit-level=high`.

## Rotating the chatbot key

**There is no rotate operation.** Basecamp's chatbot key is issued once when the chatbot is
created and cannot be regenerated in place. To rotate it you **delete the chatbot and create
a new one**, then set the new `BASECAMP_CHATBOT_KEY` (and re-check `BASECAMP_CHAT_ID`, which
changes with the new integration). Do this if the key ever appears in a log, a screenshot, a
shell history, or a ticket. Rotating the GitHub webhook secret and the GitHub token, by
contrast, is a normal in-place regeneration on GitHub's side.
