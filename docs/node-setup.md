# Node / Docker runbook

The Node container is the **fallback** target. It is a plain OCI image: nothing here
is Railway-specific except `railway.json`. Railway, Fly.io, and any Docker host all
run the same `Dockerfile`.

Before you start, read [the durability contract](#durability-at-most-once), it is
the one property that differs from the Workers target, and it is not fixable by
configuration.

## Configure

`src/config/schema.ts` is the single source of truth for every variable and default;
`.env.example` lists them all with comments. The minimum for a running container:

| Variable | Required | Notes |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | Minimum 32 characters. Generate it: `openssl rand -hex 32`. Boot refuses every placeholder literal published in this repository, in every `NODE_ENV`. |
| `BASECAMP_ACCOUNT_ID` | yes | Or set `BASECAMP_LINES_URL` instead of the four ids. |
| `BASECAMP_CHATBOT_KEY` | yes | |
| `BASECAMP_BUCKET_ID` | yes | |
| `BASECAMP_CHAT_ID` | yes | |
| `GITHUB_TOKEN` | no | Fine-grained PAT, **Contents: read**. Mandatory in practice for private repos. Without it the Changes row renders `N/A`. |
| `BRANCHES` | no | Default `main`. |
| `PORT` | no | Default `3000`. |
| `SHUTDOWN_DRAIN_MS` | no | Default `20000`. See the drain budget below. |
| `LOG_LEVEL` | no | Default `info`. |

`/healthz` returns 500 and names **every** missing key at once, so one boot tells you
the whole list.

The knobs an operator actually changes on a Node host, beyond the minimum above
(defaults from `src/config/schema.ts`; [Configuration](../README.md#configuration)
has the full table):

| Variable | Default | When you change it |
|---|---|---|
| `BASECAMP_LINES_URL` | *(none)* | Paste the chatbot's full Lines URL instead of the four `BASECAMP_*` ids. |
| `BASECAMP_API_BASE` | `https://3.basecampapi.com` | Point at `http://127.0.0.1:9999` to drive `scripts/mock-basecamp.ts` with no Basecamp account. **`BASECAMP_LINES_URL` must be empty** for this override to take effect. |
| `BASECAMP_MIN_INTERVAL_MS` | `250` | The chat-integrations pacer. Raise it if Basecamp starts answering 429; do not lower it. |
| `BASECAMP_MAX_SLEEP_MS` | `30000` | Cap on the sleep a `Retry-After` can impose. |
| `BASECAMP_TIMEOUT_MS` | `10000` | Per-request timeout to Basecamp. |
| `GITHUB_API_BASE` | `https://api.github.com` | GitHub Enterprise Server: `https://ghes.example.com/api/v3`. |
| `GITHUB_WEB_ORIGIN` | `https://github.com` | GHES web origin, so rendered links point at your instance. |
| `GITHUB_CONCURRENCY` | `4` | Parallel enrichment fetches. Raise only if you are far from the REST rate limit. |
| `GITHUB_TIMEOUT_MS` | `8000` | Per-request timeout for enrichment; a timeout renders `N/A`, it never blocks the post. |
| `GITHUB_STATS_MAX_BYTES` | `1048576` | Ceiling on a commit-stats response body. |
| `USER_AGENT` | derived from `package.json` | Sent to both APIs. |
| `ROUTES` / `CONFIG_FILE` | *(none)* | Multi-repo routing: inline JSON, or a path to `config.json`. Per-route credentials come from `GITHUB_TOKEN_<SUFFIX>` and `GITHUB_WEBHOOK_SECRET_<SUFFIX>`. |

## Railway

Deploy from the repository; `railway.json` is config-as-code and overrides the
dashboard, *"Configuration defined in code will always override values from the
dashboard"*.

```json
"drainingSeconds": 30,
"overlapSeconds": 30,
"numReplicas": 1,
"sleepApplication": false
```

- **`drainingSeconds: 30`.** Railway's default grace period is zero: *"By default, it
  is given 0 seconds to gracefully shutdown before being forcefully stopped with a
  SIGKILL"* (<https://docs.railway.com/reference/deployments>). At the default,
  SIGTERM and SIGKILL are effectively simultaneous and the in-process queue is lost on
  **every redeploy**. The budget rule is `SHUTDOWN_DRAIN_MS + 5000 <= drainingSeconds
  * 1000`: with the shipped defaults, 20,000 + 5,000 ≤ 30,000.
- **`overlapSeconds: 30`.** The new deployment absorbs incoming deliveries while the
  old one drains, so nothing arrives at a socket that is closing.
- **`numReplicas: 1` is a correctness requirement, not a cost setting.** Dedup, strict
  per-push ordering, and the Basecamp pacer are all per-process state; there is no
  shared store, by design. Two replicas give you duplicate and out-of-order messages,
  and 2× the intended request rate into Basecamp's chat-integrations bucket. The
  symptom looks exactly like a GitHub redelivery bug and gets misdiagnosed for days.
  The service logs `warn replica_index_nonzero` at boot if the platform exposes a
  non-zero replica index.
- **`healthcheckPath: /healthz`** is a deploy gate only: *"Railway will query the
  endpoint until it receives an HTTP `200` response"*, and *"Railway does not monitor
  the healthcheck endpoint after the deployment has gone live"*
  (<https://docs.railway.com/deployments/healthchecks>). Do not host-gate or auth-gate
  it: Railway probes with the hostname `healthcheck.railway.app`.
- **`restartPolicyType: ON_FAILURE`** restarts on a non-zero exit. It does not detect a
  hung-but-alive process.

### Leave Serverless disabled

Railway's sleep feature (**Serverless**, formerly App Sleeping) is opt-in and off by
default. Leave it off. From the caveats
(<https://docs.railway.com/reference/app-sleeping>):

> "The first request sent to a slept service may return a **502 Bad Gateway** response"

A GitHub delivery has 10 seconds to reach a 2xx, and GitHub does not automatically
redeliver failed deliveries. So a 502 on wake is not a slow request, it is a silently
lost push, recoverable only by a human clicking Redeliver inside the 3-day window.
Sleep is triggered by five minutes of **outbound** silence (sampled, so 5-10 minutes
in practice), which a mostly-idle relay will hit easily, and enabling it applies
across all replicas. Keep `sleepApplication: false`.

Set secrets as Railway variables, never in the image.

## Fly.io

The same image works unchanged. In `fly.toml`:

```toml
[[services]]
  internal_port = 3000
  kill_signal = "SIGTERM"
  kill_timeout = 30
```

Run **exactly one machine**, the `numReplicas: 1` reasoning above applies identically.
Set secrets with `fly secrets set`.

## Any Docker host

```bash
docker run -d --name commit-relay \
  -p 127.0.0.1:3000:3000 \
  --restart unless-stopped \
  --read-only --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --memory 512m \
  --stop-timeout 30 \
  -e GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  -e BASECAMP_ACCOUNT_ID=1234567 \
  -e BASECAMP_CHATBOT_KEY=your-chatbot-key \
  -e BASECAMP_BUCKET_ID=2345678 \
  -e BASECAMP_CHAT_ID=7654321 \
  -e GITHUB_TOKEN=<your-fine-grained-pat> \
  ghcr.io/akmofficial/commit-relay:0.1
```

`--read-only` plus root-owned application files means a compromised process cannot
rewrite `dist/`. Put TLS in front of it (a reverse proxy or your platform's edge);
GitHub webhooks should never be sent over plaintext.

`docker-compose.yml` in the repository root is the same thing with `env_file: .env`:
`docker compose up -d`.

## Verify end to end

```bash
curl -i http://localhost:3000/healthz         # 200; a 500 lists every missing key at once
pnpm send:fixture tests/fixtures/push.normal.json http://localhost:3000/webhook   # 202
docker logs -f commit-relay | grep -E 'message_posted|push_skipped|basecamp_'
docker stop -t 30 commit-relay; docker inspect -f '{{.State.ExitCode}}' commit-relay   # 0
```

`scripts/smoke.sh` automates the container half of this against a built image
(`./scripts/smoke.sh commit-relay:dev`): boot, `/healthz` 200, a deliberately bad
signature answered `401`, `docker stop -t 30` exiting 0 inside the drain window, and a
one-shot `docker stats` reading. It runs `scripts/mock-basecamp.ts` in a second
container sharing the application container's network namespace, so no Basecamp
account is needed, and it `unset`s `GITHUB_TOKEN` first, many Actions workflows map
`github.token` into a variable of that exact name, and so does a stray `.env`.

Then run the direct Basecamp `curl` and a real push from
[`docs/basecamp-setup.md`](./basecamp-setup.md). The Basecamp check is identical on
both targets.

## The SIGTERM drain

```
SIGTERM received
  1. lifecycle → "draining"; /healthz starts returning 503 immediately (first act, before anything else)
  2. server.close(): stop accepting new connections; in-flight requests finish
  3. drain the FIFO: finish the in-flight Basecamp post, then keep posting queued
     items at the normal pace until the queue is empty or SHUTDOWN_DRAIN_MS elapses
  4. log drain_complete { posted, dropped }: or drain_incomplete { remaining }
  5. process.exit(0)
```

The drain never *starts* new GitHub enrichment; pending jobs are force-promoted with
`stats: null` and posted with `N/A` in the Changes row, because a `N/A` beats a lost
message.

`docker stop` sends SIGTERM and defaults to a **10-second** grace period, which is
shorter than `SHUTDOWN_DRAIN_MS`. Always `docker stop -t 30 commit-relay`; the
compose file sets `stop_grace_period: 30s` for the same reason.

## Durability: at-most-once

Between the `202` and the Basecamp `201` the only copy of the work is process memory.
A normal deploy is covered by the SIGTERM drain, provided `drainingSeconds` is set. An
OOM kill, a segfault, or a platform-level kill loses those messages permanently:
GitHub does not auto-retry, and manual Redeliver only works for 3 days. **SIGKILL, an
OOM kill, and a host failure send no SIGTERM at all**, so the contract is at-most-once
across process death no matter how carefully the drain is written. Do not describe the
Node path as durable. The full statement:

> At-most-once across process death on the Node target; at-least-once across queue
> redelivery on the Workers target; at-least-once across transport timeouts and 429
> retries on both. Exactly-once is not offered.

## Memory

Steady-state RSS **budget**: **55-70 MB**, ~90 MB peak, under
`--max-old-space-size=128 --max-semi-space-size=4`. This is the section 12.1 budget,
**not a measurement**: no `docker stats` figure has been recorded yet. Run
`./scripts/smoke.sh`, which prints one `docker stats` reading, and replace this
figure with the observed value.

The heap cap and the alpine base are deliberate: Railway bills memory including page
cache and shmem, which is observed and staff-confirmed, not documented anywhere in
Railway's docs.
