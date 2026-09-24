# Troubleshooting

Every fix below ends the same way: GitHub's **Settings → Webhooks → Recent Deliveries → Redeliver** replays the exact payload against your fix. It is the fastest debug loop there is, and the one most people don't know exists. GitHub does not redeliver a failed delivery by itself, and the button expires after 3 days.

On Workers, watch the logs live with `npx wrangler tail`. Every skipped push logs a `push_skipped` line naming the reason, the branch, and every pattern tried.

| Symptom | Cause | Fix |
|---|---|---|
| Every delivery is 401 and the secret looks right | The hook is set to `application/x-www-form-urlencoded`, so GitHub signs `payload=%7B...` | Change Content type to `application/json` |
| 415 in the log | The same thing, detected explicitly | As above |
| 401 with the content type right | The webhook's Secret differs from `GITHUB_WEBHOOK_SECRET`, or the repo's route uses its own `webhookSecretEnv` | Paste the same value in both places |
| 202 on GitHub, nothing in Campfire, no error | A filter dropped it: most often the branch is not in `BRANCHES`, or the repo is not in `REPO_ALLOWLIST` | Find the `push_skipped` log line, fix the setting |
| Basecamp returns 401 | Wrong, rotated, or deleted chatbot key. Basecamp has no key rotation | Recreate the chatbot, update `BASECAMP_LINES_URL` |
| Basecamp returns 404 | Bucket and chat ids swapped or wrong | Copy the whole URL from the chatbot again, in one go |
| Basecamp returns 400 | Missing `User-Agent` | Set `USER_AGENT` to a name plus a contact URL or email |
| Messages land in the wrong room | The ids came from two different chatbot URLs, or a `ROUTES` target overrides the flat values | Take all four from one URL; check the matched route's `target` |
| The Changes row is always `N/A` | No `GITHUB_TOKEN`, the repo is private and not in the token's list, or the stats call failed | Add the repo to a fine-grained token with Contents: read. `REQUIRE_LINE_STATS=true` makes boot refuse the silent version |
| `error github_token_rejected` in the log | The token expired or was revoked | Create a new token, update `GITHUB_TOKEN` |
| Duplicate messages | A queue redelivery re-posted after a crash, or more than one Node replica is running | Expected occasionally on Workers (at-least-once). On Node, run exactly one replica |
| `GET /healthz` returns 500 with `{"status":"config_invalid","missing":[…]}` | Those settings are unset, empty, or invalid | Fix every named one; the list is complete, so one redeploy clears them all |
| `GET /healthz` returns 503 with `basecamp_terminal` | Basecamp rejected a post with 401, 403 or 404 | Fix the chatbot URL; the next successful post to that room clears it |
| `Error: Too many subrequests.` | Workers Free allows 50 outbound calls per invocation | Lower `MAX_COMMITS_PER_PUSH`, or move to Workers Paid |
| `waitUntil() tasks did not complete within the allowed time…` | Running with no queue binding, over the 30 s budget | Create the queues and restore the `queues` block in `wrangler.jsonc` |
| A rebase or `git push --force` posted nothing | `SKIP_FORCED_PUSHES` is on | Turn it off to get one rollup labelled as a force push |
| Deploy fails with API error 100328 | A Workers Paid setting (`limits.cpu_ms`) on a Free account | Remove the `limits` block from `wrangler.jsonc` |
