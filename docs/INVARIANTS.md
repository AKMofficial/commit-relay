# Enforced source rules

Six rules hold this service together. None of them is a style preference and none is enforced by
review: each is a grep over `src/**` in `tests/invariants.test.ts`, which runs in both vitest
projects. A change that breaks one fails the build.

The sources are read with Vite's `?raw` glob rather than `node:fs`, because `workerd` has no
filesystem and the same file has to run under the Workers pool (section 15.3).

---

## 1. No `===` or `!==` on a credential

**Why.** A byte-by-byte comparison bails out on the first mismatch, which leaks the correct prefix
one request at a time. `crypto.subtle.verify` is constant-time by construction, and Cloudflare's own
signing example gives this exact reason. The rule is written against identifier names, anything
containing `token`, `secret`, `hash`, `digest` or `signature`, because a name is what a reviewer
sees, and a rule you cannot check by eye is not a control.

A comparison against `undefined`, `null`, `''` or `0` is allowed: a presence check compares against a
literal, not against a second value, so there is no prefix to leak.

**What breaks.** A `sign()`-then-compare implementation of signature verification, a hand-rolled
token equality check, or a `node:crypto` import creeping in on the Node target and diverging the two
platforms.

**Which test.** `tests/invariants.test.ts`, *1. no equality comparison on a credential*.

---

## 2. The Basecamp endpoint reaches no log line, thrown error, or health response

**Why.** `BASECAMP_CHATBOT_KEY` is a URL **path segment**, so the posting URL *is* the credential.
Any code path that logs a URL leaks it, and `fetch` failures carry the request URL in their `cause`
chain. `src/basecamp/client.ts` is therefore the only file that builds the URL, the only file that
calls `linesUrl()`, and it logs only `redactLinesUrl(url)`.

**What breaks.** A chatbot key in the operator's log aggregator, in a `TypeError: fetch failed`
message forwarded to an error tracker, or in a `/healthz` body served unauthenticated.

**Which test.** `tests/invariants.test.ts`, *2. the Basecamp endpoint reaches no log, error or
health response*. Redaction itself is covered by `src/security/redact.test.ts` and
`src/obs/log.test.ts`; this rule is the belt to that pair of braces.

---

## 3. Every value interpolated into HTML is escaped, and every `href` passes `safeUrl()`

**Why.** A contributor to a public repo controls the commit subject, the author name and the branch
name. The renderer's job is to make those inert. The check collects every template literal in
`src/render/` that contains a tag and requires each interpolated expression to be one of an
allow-list: `escapeHtml(...)`, `plain(...)`, an `S.*` string-table constant, a local whose name ends
in `Html`, or a named local whose safety is documented in the test beside it. Anything else fails, 
it is an allow-list, not a blocklist of dangerous shapes, so a new unescaped value is a failure by
default rather than an oversight.

Literals with no tag in them are exempt on purpose: section 8.2 truncates the **source** before
escaping, so `src/render/truncate.ts` legitimately handles raw text the caller escapes afterwards.

Escaping says nothing about URL schemes, so a second check requires every `href="${…}"` to
interpolate the result of `safeUrl()`, which is https-only and origin-checked.

**What breaks.** `</td></tr><script>alert(1)</script>` in a commit subject rendering as markup in a
private room, or `javascript:` in `commits[].url` becoming a clickable link the room trusts because
the bot posted it.

**Which test.** `tests/invariants.test.ts`, *3. every value interpolated into HTML is escaped*, with
the behavioural coverage in `src/render/message.test.ts` and `tests/e2e.webhook.test.ts`.

---

## 4. The request body is read exactly once, as bytes, before any parse

**Why.** The signature is over the raw bytes GitHub sent. Key order survives a JSON round trip but
unicode escaping and float formatting do not, so verifying a re-serialization verifies a different
document. Reading the body twice is not possible at all: the stream is consumed. The handler reads it
through one capped reader, verifies those bytes, and `JSON.parse`s the same buffer.

**What breaks.** A `c.req.json()` added for convenience ahead of the signature check: every delivery
would then be parsed before it was authenticated, and the 401 path would allocate on
attacker-controlled input.

**Which test.** `tests/invariants.test.ts`, *4. the request body is read exactly once, as bytes,
before any parse*, alongside the gate-ordering cases in `src/http/webhook.test.ts`. The grep asserts
the property rather than one spelling: every `JSON.parse` argument in the handler is the decode of
`raw`, inline or through a local bound to it, so rewriting the two lines as one (or one as two) stays
green while a second body source does not.

---

## 5. The module boundaries

**Why.** The dual typecheck and these greps are what keep `src/core/**`, `src/relay/**` and `src/render/**`
platform pure, which is the only reason the same code runs on Workers and on Node. The rest of the group are
single-owner rules: one file builds the Basecamp URL, one file writes to the console, one file emits
HTML, one file imports Hono.

| Rule | What breaks without it |
|---|---|
| Only `src/http/app.ts` imports `hono`; only `src/server.ts` imports `@hono/node-server` | The Workers bundle pulls in a Node HTTP server, or core logic becomes framework-shaped |
| `src/core/**`, `src/relay/**` and `src/render/**` import no `node:*`, `cloudflare:*` or `hono` | The Workers build fails at deploy time rather than in CI: `nodejs_compat` is off permanently |
| Only `src/obs/log.ts` calls `console.*` | An unredacted line bypasses the serializer where the shape-based redactor lives |
| Only `src/render/**` emits `<table>`/`<tr>`/`<td>` | HTML assembled outside the one escaped, tested renderer |
| `relayPush()` and `relayPullRequest()` are called only from `src/queue/consumer.ts` | A second path into the pipeline that skips delivery-id dedup and outcome recording |
| No `Date.now(` anywhere in `src/basecamp/`, `src/queue/` or `src/relay/` | `workerd` freezes the observable clock outside I/O, so a busy-wait on a clock delta never terminates: and `wrangler dev` does not reproduce it |
| No `Promise.all` in `src/relay/poster.ts` | A Worker gets six simultaneous connections; a fan-out silently serialises into waves of six and mis-tunes every backoff |
| `src/security/hmac.ts` imports nothing from `src/config/` | Secret *policy* (length, denylist) leaking into the primitive, which takes the secret as an argument and enforces nothing |

**Which test.** `tests/invariants.test.ts`, *5. the module boundaries*.

---

## 6. `nodejs_compat` stays out of `wrangler.jsonc`

**Why.** `nodejs_compat` is the canary the platform-purity greps depend on. With it enabled, a stray `node:*` import can ship to Workers and the dual typecheck loses its bite. The compatibility date is pinned below the threshold where Cloudflare enables `nodejs_compat` by default, and `tests/invariants.test.ts` asserts the flag never appears in `compatibility_flags`.

**What breaks.** A contributor adds `node:crypto` to shared code, the Workers deploy succeeds, and the Node-only fallback becomes the only target that still enforces purity.

**Which test.** `tests/invariants.test.ts`, *6. nodejs_compat stays off in wrangler.jsonc*.
