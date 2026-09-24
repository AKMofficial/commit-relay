# commit-relay

Post every Git commit into a Basecamp Campfire chat, as a table.

[![CI](https://github.com/AKMofficial/commit-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/AKMofficial/commit-relay/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AKMofficial/commit-relay?sort=semver)](https://github.com/AKMofficial/commit-relay/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GHCR](https://img.shields.io/badge/ghcr.io-commit--relay-blue)](https://github.com/AKMofficial/commit-relay/pkgs/container/commit-relay)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/AKMofficial/commit-relay/badge)](https://scorecard.dev/viewer/?uri=github.com/AKMofficial/commit-relay)

When someone pushes to GitHub, commit-relay posts each commit to your Campfire room: the repo, branch, author, files changed, lines added and removed, the full message, and a link to the commit. Pull requests get a message too, when they are opened, merged, closed, reopened, marked ready, or reviewed.

You run it yourself. It's free on Cloudflare Workers.

![A commit posted in a Campfire room](docs/media/message.png)

## Why not the built-in integration or Zapier

- **You see how big each commit is.** Every message shows lines added and removed.
- **Every branch, clearly labelled.** You can limit it to the branches you care about.
- **Pull requests too**, not just commits.
- **No cost per commit.** Zapier-style tools charge per run, so a 20-commit push is 20 runs. This costs nothing on Workers Free.
- **Nothing passes through anyone else.** Your commit messages and Basecamp key stay in your own deployment.

## What you need

Three values. Get them before you deploy.

| Value | Where to get it |
|---|---|
| `BASECAMP_LINES_URL` | In your Campfire room, click **•••** → **Configure chatbots** → add a chatbot, then copy the URL it shows. It looks like `https://3.basecampapi.com/1234567/integrations/KEY/buckets/2345678/chats/7654321/lines.json`. Keep it private: anyone with it can post in your room. [Step by step](docs/basecamp-setup.md) |
| `GITHUB_WEBHOOK_SECRET` | A password you make up. Run `openssl rand -hex 32` and save the result. Every GitHub webhook uses this same value |
| `GITHUB_TOKEN` | Only if your repos are private. A [fine-grained token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) with **Contents: Read-only** on those repos. Without it, private repos still post, but line counts show `N/A` |

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AKMofficial/commit-relay)

1. Click the button and sign in to GitHub and Cloudflare.
2. Enter the three values. If all your repos are public, type a single space for `GITHUB_TOKEN`.
3. Click deploy. When it finishes, copy your Worker's URL, like `https://commit-relay.<you>.workers.dev`.
4. Open `https://<your-worker-url>/healthz` in a browser. `{"status":"ok"}` means it's working. Anything else tells you which value is wrong.

The button makes a copy of this project in your GitHub account and deploys that copy. Updates made here don't reach your copy by themselves: [how to update it](docs/cloudflare-setup.md#updating-a-deploy-button-copy). To deploy from the command line instead, see [Cloudflare setup](docs/cloudflare-setup.md).

**Or run it with Docker**, on any server with HTTPS in front of it:

```bash
docker run -d --name commit-relay -p 3000:3000 --restart unless-stopped \
  -e BASECAMP_LINES_URL="<your chatbot URL>" \
  -e GITHUB_WEBHOOK_SECRET="<your secret>" \
  -e GITHUB_TOKEN="<your token, or leave this line out>" \
  ghcr.io/akmofficial/commit-relay:0.1
```

Railway, Fly.io and safer Docker settings are in [Node and Docker](docs/node-setup.md).

## Add a repository

Do this once for each repo you want in the room. On GitHub, open the repo → **Settings** → **Webhooks** → **Add webhook**, and fill in:

- **Payload URL**: your Worker URL with `/webhook` on the end
- **Content type**: `application/json` (the default won't work)
- **Secret**: your `GITHUB_WEBHOOK_SECRET`
- **Which events**: choose **Let me select individual events**, then tick **Pushes**, **Pull requests** and **Pull request reviews**

Click **Add webhook**. GitHub sends a test right away; under **Recent Deliveries** it should show `204`.

If the repo is private, also add it to your token's list of repos.

Now push a commit. It shows up in the room within a few seconds.

## Common settings

You don't need to change anything. If you want to, these are the useful ones. Set them in `wrangler.jsonc` under `vars`:

| Setting | Default | What it does |
|---|---|---|
| `BRANCHES` | every branch | Only post these branches, e.g. `main,release/*` |
| `REPO_ALLOWLIST` | any repo | Only accept these repos, e.g. `your-org/*` |
| `IGNORE_AUTHORS` | nobody | Skip commits by these authors, e.g. `dependabot[bot]` |
| `TAGS` | no tags | Also post these tag pushes, e.g. `v*` |

On a Deploy-button copy, edit `wrangler.jsonc` in your copy on GitHub and commit; Cloudflare redeploys by itself. Don't set these in the Cloudflare dashboard: each deploy overwrites them with `wrangler.jsonc`.

Secrets are different. To add one later, like `GITHUB_TOKEN`, use the Cloudflare dashboard: your Worker → **Settings** → **Variables and Secrets** → **Add**, type **Secret**.

Sending different repos to different rooms, and every other setting, are in the [configuration guide](docs/configuration.md).

## How it works

GitHub tells commit-relay about each push. commit-relay checks the message really came from GitHub (that's what the secret is for), looks up the line counts, and posts one message per commit to your room. It keeps no database.

Good to know:

- **Big pushes become one message.** More than 15 commits in one push, a new branch, or a force push posts a single summary instead of one message per commit.
- **Commits from one push arrive in order.** Two pushes at the same moment can mix.
- **You may see a commit twice** after a squash or rebase merge, because GitHub gives those commits new IDs.
- **GitHub doesn't retry by itself.** If a delivery fails, open **Recent Deliveries** and click **Redeliver**. That button works for 3 days.
- **`/healthz` shows if something is wrong**: `200` all good, `500` a setting is missing or invalid, `503` Basecamp is rejecting posts (for example, the chatbot was deleted).

## When something goes wrong

Start on GitHub: repo → **Settings** → **Webhooks** → **Recent Deliveries**. It shows what happened to each push, and **Redeliver** tries it again after you fix something.

| You see | Fix |
|---|---|
| Every delivery shows `401` | Set Content type to `application/json`, and check the secret matches |
| `202`, but nothing in the room | The branch or repo is filtered out. Check `BRANCHES` and `REPO_ALLOWLIST` |
| Line counts always show `N/A` | The repo is private and not in your token's list |
| `/healthz` shows `500` | It names the setting that's missing or wrong |

More problems and fixes: [troubleshooting](docs/troubleshooting.md).

## FAQ

**Slack or Discord?** No, only Basecamp. Slack and Discord already have good GitHub apps.

**GitHub Enterprise?** Yes. Set `GITHUB_API_BASE` and `GITHUB_WEB_ORIGIN` to your server. If it only accepts known IP addresses, use the Docker version, because Cloudflare's addresses change.

**More than one room, or more than one GitHub organization?** Yes. See [configuration](docs/configuration.md#routes-multi-repo-multi-room).

**Monorepos?** Yes, but every commit on an allowed branch posts. There's no filter by folder.

**Issues or other events?** No. Only pushes, pull requests and reviews.

**What does it cost?** Nothing on Cloudflare's free plan. With Docker, whatever your smallest server costs.

**Why one message per commit, not a daily summary?** A summary would need a database and a schedule. One message per commit keeps it simple, and you can search the room for a commit.

**What about a 500-commit push?** You get one summary message, not 500.

## Documentation

- [Basecamp setup](docs/basecamp-setup.md): create the chatbot and get its URL
- [Cloudflare setup](docs/cloudflare-setup.md): command-line deploy, and updating a Deploy-button copy
- [Node and Docker](docs/node-setup.md): run it as a container
- [Configuration](docs/configuration.md): every setting, multiple rooms, branch patterns
- [Troubleshooting](docs/troubleshooting.md): problems and fixes

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [License: MIT](LICENSE)

Not affiliated with, endorsed by, or sponsored by 37signals, LLC. Basecamp® and Campfire® are trademarks of 37signals, LLC. This project is an independent, unofficial integration.
