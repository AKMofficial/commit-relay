# Cloudflare Workers runbook

The primary deployment target. Everything below runs on the Workers **Free** plan.

Related: [Basecamp setup](./basecamp-setup.md) · [Configuration reference](./configuration.md) · [Basecamp compatibility log](./basecamp-compat.md) · [Node runbook](./node-setup.md)

> **Operator checks.** Steps marked **[operator]** need a real Cloudflare account, a
> real repository, and a real Campfire room. They cannot be run from the repository
> alone, and their results are written down here by whoever runs them.

## 1. Prerequisites

| Need | Detail |
|---|---|
| Cloudflare account | Free is enough to run this; see [Free vs Paid](#7-free-vs-paid-stated-plainly) for what Free costs you |
| Node + pnpm locally | Only to run `wrangler`; the deployed Worker runs no Node |
| The four Basecamp values | account id, chatbot key, bucket id, chat id: see [Basecamp setup](./basecamp-setup.md) |
| A webhook secret | `openssl rand -hex 32` |
| A GitHub token | Mandatory in practice for private repos: unauthenticated commit lookups return 404 |

## 2. Step by step, from zero

```bash
# 1. Get the code (fork first if you intend to use the deploy button)
git clone https://github.com/AKMofficial/commit-relay.git
cd commit-relay
pnpm install

# 2. Authenticate wrangler
npx wrangler login

# 3. Create BOTH queues before the first deploy (see section 4)
npx wrangler queues create commit-relay-commits
npx wrangler queues create commit-relay-dlq

# 4. Set secrets. EVERY Basecamp value is a secret - none of them go in
#    wrangler.jsonc "vars", which is a committed file.
npx wrangler secret put BASECAMP_LINES_URL    # whole URL, chatbot key included
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN          # optional; required for private repos

# 5. Behaviour knobs only live in wrangler.jsonc "vars" - edit them, then:
npx wrangler deploy

# 6. Note the URL wrangler prints, e.g. https://commit-relay.<subdomain>.workers.dev
curl -i https://commit-relay.<subdomain>.workers.dev/healthz     # expect 200

# 7. Watch it work
npx wrangler tail --format pretty
```

Then add the webhook to each repository, per [the GitHub webhook](#21-the-github-webhook)
below.

### 2.1 The GitHub webhook

**[operator]** This is the one mandatory GitHub-side step and it is done in the browser,
on a repository you administer.

1. Open the repository → **Settings** → **Webhooks** (left sidebar, under *Code and
   automation*) → **Add webhook**. The Settings tab is only shown to repo admins.
2. **Payload URL**: `https://<your-worker-url>/webhook`, the URL `wrangler deploy`
   printed plus the `/webhook` path. It must be public and `https://`.
3. **Content type**: **`application/json`**. Do not leave it on
   `application/x-www-form-urlencoded`: form encoding signs different bytes, and the
   result is a `401` that looks exactly like a wrong secret.
4. **Secret**: the same value you set as `GITHUB_WEBHOOK_SECRET`. Blank is not
   supported; the Worker refuses to boot without a secret, so every delivery would be
   rejected.
5. **SSL verification**: leave **Enable SSL verification** selected.
6. **Events**: *Let me select individual events*, then tick **Pushes**, **Pull
   requests**, and **Pull request reviews**. *Just the push event* relays commits
   only; *Send me everything* is wrong, because every other event costs a
   delivery the Worker answers `204` and discards.
7. Leave **Active** ticked and click **Add webhook**.

GitHub immediately sends one `ping`. Reload the page, open **Recent Deliveries**, and
expect a `ping` row with a `204`.

An organization webhook (`https://github.com/organizations/your-org/settings/hooks`)
covers every repository in the org with one hook and the same four settings; it needs
org-owner rights.

## 3. What `wrangler.jsonc` declares

`wrangler.jsonc` is committed. Read it alongside this section; the notes below explain
why each block is the way it is.

| Block | Value | Why |
|---|---|---|
| `compatibility_date` | `2026-08-03`, pinned | For compatibility dates of 2026-08-04 or later, Workers enables `nodejs_compat` and `nodejs_compat_v2` by default. This project keeps `nodejs_compat` **off** permanently as a portability canary, so the date stays below that threshold and `compatibility_flags` stays empty. Do not bump it. |
| `observability` | `enabled: true`, `head_sampling_rate: 1` | Workers Logs carries the boot-error list and every `push_skipped` line. |
| `limits` | *(absent)* | Deliberately not set. Free does not ignore `limits.cpu_ms`, it rejects the deploy with API error 100328, which would break the Deploy button for every Free account. On **Paid**, add `"limits": { "cpu_ms": 30000 }` yourself. |
| `queues.producers` | binding `COMMITS` → `commit-relay-commits` | The webhook enqueues one job per push. |
| `queues.consumers[].max_batch_size` | `1` | Must be 1. One message = one push = up to `MAX_COMMITS_PER_PUSH` (15) stats calls + 15 posts = 30 external subrequests, plus one retry round = 45, plus 1 of headroom for a rollup on an adjacent trigger and 4 in reserve = 50, against the Free hard ceiling of 50 external subrequests per invocation. A capped push posts only the rollup and makes no GitHub calls, so the 30-post case and the rollup case never co-occur: which is what makes the 45 + 1 + 4 = 50 budget hold. Two pushes in one batch blows the ceiling. |
| `queues.consumers[].max_batch_timeout` | `1` | One second. With `max_batch_size: 1` there is nothing to wait for, so the consumer is dispatched as soon as a push arrives. |
| `queues.consumers[].max_concurrency` | `1` | One push processed at a time per consumer invocation. This is not a global account ceiling by itself. |
| `queues.consumers[].max_retries` | `5` | Cloudflare's default is 3; the limit is 100. |
| `queues.consumers[].dead_letter_queue` | `commit-relay-dlq` | Without a DLQ, messages that exhaust `max_retries` are deleted permanently. |
| `vars` | `BRANCHES`, `MAX_COMMITS_PER_PUSH`, `GITHUB_CONCURRENCY`, `LOG_LEVEL` | Behaviour knobs only. Every binding arrives as a **string**; the config layer coerces. No `BASECAMP_*` key of any kind belongs here, not even a placeholder id: CI fails the build if one reappears. |

**Per-isolate limits.** The pre-HMAC rate limiter and both dedup maps live in module state inside one Workers isolate. Cloudflare runs many isolates, so a determined attacker can spread load across them. For a true global ceiling, add a Cloudflare WAF rate-limiting rule on `POST` to your webhook path in front of the Worker.

The DLQ deliberately has **no consumer**. Cloudflare: *"Messages delivered to a DLQ
without an active consumer will persist for four (4) days before being deleted from
the queue"*.

That four-day figure is the **Workers Paid** retention default. On the **Free** plan
queue retention is **24 hours and not configurable**
([Free vs Paid](#7-free-vs-paid-stated-plainly)), so a poison message is deleted well
inside GitHub's 3-day redelivery window: on Free, inspect and act on a DLQ message the
same day it lands, or redeliver from GitHub's **Recent Deliveries** before the message
expires. Only on Paid does the retention window outlast the redelivery window.

Sources: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/> ·
<https://developers.cloudflare.com/workers/platform/limits/#subrequests> ·
<https://developers.cloudflare.com/queues/configuration/batching-retries/> ·
<https://developers.cloudflare.com/queues/configuration/dead-letter-queues/>

## 4. Must the queues exist before the first deploy?

**Yes, for `wrangler deploy`.** Cloudflare's own Queues walkthrough creates the queue
with `npx wrangler queues create <name>` as a prerequisite step, before the binding is
added and before deploying (<https://developers.cloudflare.com/queues/get-started/>).
Nothing in the Wrangler docs says a `wrangler deploy` auto-creates a queue named in the
config, so treat creation as required, and create the DLQ too. The DLQ is a config
**string** on the consumer, not a binding, and no Cloudflare page states that it is
created for you.

**If you skip it:** the deploy is rejected because the config references a queue that
does not exist. It does not deploy-then-fail-at-runtime. The precise error text is not
documented; do not script against it.

### The binding-presence fallback

That is a different situation: a deploy with **no queue at all**. Delete the entire
`"queues"` block and the Worker still deploys and still works, degraded, the push is
processed inside `ctx.waitUntil` instead of on a queue consumer.

| | Queue present | No queue binding |
|---|---|---|
| Time budget after the 202 | consumer invocation, 15 min wall clock | **30 s**, shared across all `waitUntil()` calls in the request |
| Retries | `max_retries: 5`, with `message.retry({ delaySeconds })` on a Basecamp 429 | none |
| Poison messages | land in the DLQ | lost |
| On overrun | n/a | tasks are cancelled and Workers Logs shows `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.` |
| Subrequest budget | one invocation per push | the push's subrequests share the request invocation's budget: on Free that is the same hard 50 |

Degraded mode is a legitimate way to try the project in five minutes. It is not a way
to run it.

**[operator]** Confirm the degraded path on your own account: deploy once with the
`queues` block removed, push, and check that the message still arrives. Record the
result below.

## 5. Secrets

| Where | How | Notes |
|---|---|---|
| Production | `npx wrangler secret put NAME` | Never in `vars`, never in the repo. `wrangler secret list` shows names only. |
| Local dev | `.dev.vars` (gitignored) | `wrangler dev` loads it automatically. |
| Deploy button | `.dev.vars.example` **or** `.env.example`, committed | Documented dotenv format, e.g. `GITHUB_WEBHOOK_SECRET=generate-with-openssl-rand-hex-32 # required` |
| Rotation | `wrangler secret put` again, then update GitHub's webhook secret | The chatbot key cannot be rotated in Basecamp; you delete and recreate the chatbot: see [Basecamp setup](./basecamp-setup.md). |

Setting `BASECAMP_LINES_URL` collapses all four Basecamp values into one secret. That is
the recommended form; see [Configuration](./configuration.md#basecamp).

## 6. The Deploy to Cloudflare button

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AKMofficial/commit-relay)
```

Cloudflare clones your repo into the visitor's own GitHub/GitLab account, shows one
setup page for names and bindings, builds with Workers Builds, and provisions the
resources the Wrangler config declares
(<https://developers.cloudflare.com/workers/platform/deploy-buttons/>).

| Requirement | Status |
|---|---|
| Repository **must be public** | Documented, hard requirement |
| Host must be `github.com` or `gitlab.com` | Documented; self-hosted GitHub/GitLab **not** supported |
| Workers application, not Pages | Documented |
| Monorepos | Documented as **not fully supported** |
| Secrets prompt | Declare them in `.dev.vars.example` or `.env.example`, dotenv format. Whether the UI *requires* a value before deploying is **not documented** |
| Binding descriptions | Optional, in `package.json` |
| Queues auto-provisioned | **Yes**, documented: Queues is on the auto-provisioned list, so a button user does not run `wrangler queues create` |
| **Dead-letter queue auto-provisioned** | **NOT DOCUMENTED.** A DLQ is a string property on a consumer, not a binding, and no Cloudflare page covers it. Do not promise it works; verify the DLQ exists after your first deploy |
| Default resource names/ids in the repo | Required: *"please make sure your source repository includes default values for resource names, resource IDs and any other properties for each binding"* |
| Build command | If no `deploy` script exists, Cloudflare preconfigures `npx wrangler deploy` |

**[operator]** Test the button from a **fresh** Cloudflare account with a fork of a
public repo, and write the answers down here:

- Did `.dev.vars.example` surface every secret in the setup UI?: **unverified**
- Was the dead-letter queue auto-provisioned?: **unverified**

## 7. Free vs Paid, stated plainly

| | Workers Free | Workers Paid |
|---|---|---|
| Queues | Available: **10,000 operations/day**, retention 24 h non-configurable | 1M ops/month included, then $0.40/M; retention 4 days default, up to 14 |
| External subrequests per invocation | **50, not raisable** (+1,000 to Cloudflare services) | 10,000 default, raisable to 10M via `limits.subrequests` |
| CPU time per request | 10 ms | 30 s default, up to 5 min |
| Requests | 100,000/day **per account**, resetting midnight UTC; over it, Error 1027 | billed per million |
| Workers Logs | 200,000 events/day, 3-day retention | 20M/month included, 7-day retention |
| Request body | 100 MB (keyed on the **Cloudflare account** plan, not the Workers plan) | 100 MB on Pro; more on Business/Enterprise |

Sources: <https://developers.cloudflare.com/queues/platform/pricing/> ·
<https://developers.cloudflare.com/workers/platform/limits/> ·
<https://developers.cloudflare.com/workers/observability/logs/workers-logs/>

What that means concretely:

- **Free works.** GitHub's 25 MB webhook cap fits inside the 100 MB body limit with 4×
  headroom, and the queue is real. The older "Queues are Paid only" claim is stale.
- **The 50-subrequest ceiling is the binding constraint on Free.**
  `MAX_COMMITS_PER_PUSH` defaults to 15 precisely so the worst case stays under it.
  Raising it on Free produces `Error: Too many subrequests.`, surfacing as
  `exceededResources` in metrics and `exception` in `wrangler tail`.
- **Whether subrequests inside `ctx.waitUntil()` count against that cap is not
  documented.** This project assumes they do. Budget as if they do.
- **10 ms CPU is not a problem**: waiting on `fetch` does not count as CPU time, and
  this Worker's own work is HMAC verification plus string building.
- **The 100,000 requests/day is account-wide**, not per Worker. A push webhook plus a
  queue consumer invocation per push is 2; you would need 50,000 pushes a day to notice.

**[operator]** Measure the subrequest budget on a full-size push (15 commits) and record
the observed count here. Expected: 2N plus one retry round, inside the Free ceiling of
50.: **unverified**

## 8. Verify end to end

```bash
# 1. Config is complete. 200 = every required key resolved. A 500 lists
#    EVERY missing or invalid key at once, names only, never values:
#      {"status":"config_invalid","missing":["BASECAMP_CHAT_ID","GITHUB_WEBHOOK_SECRET"]}
curl -i https://<your-worker-url>/healthz

# 2. Basecamp credentials are correct, independently of GitHub. Substitute
#    all four of your own values into the URL; the ones below are placeholders.
#    Expect exactly 201. 401 = bad chatbot key. 404 = bad bucket or chat id.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "https://3.basecampapi.com/1234567/integrations/PLACEHOLDERKEY0123456789/buckets/2345678/chats/7654321/lines.json" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -H 'User-Agent: commit-relay (jane@example.com)' \
  --data '{"content":"commit-relay connectivity check"}'

# 3. A bad signature is rejected, with no hint as to why.
curl -i -X POST https://<your-worker-url>/webhook \
  -H 'content-type: application/json' \
  -H 'x-github-event: push' \
  -H 'x-hub-signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
  --data '{}'                                  # expect 401

# 4. A real push, watched live.
npx wrangler tail --format pretty
git commit --allow-empty -m "chore: verify commit-relay" && git push
```

Green means all four of: GitHub's **Recent Deliveries** shows `202`; `wrangler tail`
shows the enqueue and then a `message_posted`; the Campfire room shows the table; and
the Basecamp response was `201`. If Recent Deliveries shows `202` but nothing arrives,
the reason is in the `push_skipped` log line, which names the branch and every pattern
that was tried, the reason codes are listed in
[Configuration](./configuration.md#skip-reason-codes).

**[operator]** Steps 1, 2 and 4 above, plus the DLQ check below, require live
infrastructure and are run by whoever deploys:

- `wrangler deploy --dry-run` bundles clean with **no** `nodejs_compat`: runnable
  locally, and part of CI.
- A real push to a real repository lands a table in a real Campfire room, and
  `wrangler tail` shows the `message_posted` event., **unverified**
- The DLQ receives a message that exhausts its retries.: **unverified**
