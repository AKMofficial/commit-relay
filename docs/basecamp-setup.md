# Basecamp setup: getting the four values

You need `ACCOUNT_ID`, `CHATBOT_KEY`, `BUCKET_ID`, and `CHAT_ID`. Three of the four are
readable straight from the address bar; the fourth appears when you create the chatbot.

Related: [Configuration reference](./configuration.md) · [Cloudflare runbook](./cloudflare-setup.md) · [Basecamp compatibility log](./basecamp-compat.md) · [Node runbook](./node-setup.md)

Those four names are the **path segments of the posting URL**, and they are used as
placeholders here for exactly that reason. They are not variable names: what you set in
the environment is `BASECAMP_ACCOUNT_ID`, `BASECAMP_CHATBOT_KEY`, `BASECAMP_BUCKET_ID`,
`BASECAMP_CHAT_ID`, and the value of each is the literal you read below, a 7-digit
number, never the word `ACCOUNT_ID`. The examples use three deliberately distinct
placeholders, `1234567` for the account, `2345678` for the bucket, and `7654321` for the
chat, so a transcription slip is visible rather than invisible. Setting
`BASECAMP_LINES_URL` to the whole URL instead skips this transcription entirely and is
the recommended path.

**Before you start.** You must be an **administrator** on the Basecamp account:
*"chatbots can only be managed by administrators"*, and *"the `command_url` and
`lines_url` fields are only included in the JSON responses below when the requester is
an administrator."* If you are not an admin, ask one to do steps 3 and 4 for you.

Also, from the same page: *"chatbots are account-wide... So you create a chatbot on a
specific Basecamp to get the callback URL for that Basecamp, but the chatbot will
instantly be available to every other Basecamp on the account as well. This also means
that any edits or deletes of chatbots are account-wide."* Creating a bot in one project
makes it visible everywhere, and deleting it breaks every project using it.

## Step 1: open the chat room

Log in at `https://basecamp.com`, open the project you want messages in, and click its
**Campfire** tool (labelled **Chat** on some accounts).

## Step 2: read three values from the address bar

With the chat room open, the URL is:

```
https://3.basecamp.com/1234567/buckets/2345678/chats/7654321
                       ^^^^^^^         ^^^^^^^       ^^^^^^^
                       ACCOUNT_ID      BUCKET_ID     CHAT_ID
```

| Value | Where it is | Example |
|---|---|---|
| `ACCOUNT_ID` | The number immediately after `3.basecamp.com/` | `1234567` |
| `BUCKET_ID` | The number immediately after `/buckets/` | `2345678` |
| `CHAT_ID` | The number immediately after `/chats/` | `7654321` |

A "bucket" is a project: *"Every project has exactly one bucket, its storage container
for all content. The `bucket_id` and project ID are the same value."*

Two ways to read the wrong number:

- **If you clicked a link to a specific message**, the URL ends with `@` and a second
  number, like `.../chats/7654321@<message-id>`. Take only the digits **before** the
  `@`. The part after it is one message's id.
- **Use the chat room's own URL, not the project home page.** A project home URL looks
  like `https://3.basecamp.com/1234567/projects/2345678`, it has no `/chats/` segment
  at all and cannot give you a `CHAT_ID`.

## Step 3: create the chatbot

Basecamp's help article: *"To set one up, open a project, go to Chat, click •••, and
select Configure chatbots."*

1. In the chat room, click the **•••** menu (top right).
2. Choose **Configure chatbots**.
3. Click **Add a new chatbot**.
4. Give it a **name**. Basecamp's rule: *"No spaces, emoji or non-word characters are
   allowed"*, `commitrelay` works. An avatar is optional.
5. Leave the **command URL** field **empty**. That field is only for interactive bots
   that answer commands. This one only posts.
6. Click **Add this chatbot**.

## Step 4: take the key out of the URL Basecamp shows you

```
https://3.basecampapi.com/1234567/integrations/PLACEHOLDERKEY0123456789/buckets/2345678/chats/7654321/lines
                          ^^^^^^^               ^^^^^^^^^^^^^^^^^^^^^^^^         ^^^^^^^       ^^^^^^^
                          ACCOUNT_ID            CHATBOT_KEY                      BUCKET_ID     CHAT_ID
```

`CHATBOT_KEY` is the random string between `/integrations/` and `/buckets/`, roughly 24
characters of mixed-case letters and digits. This one URL confirms all four values at
once, which makes it the best cross-check against a mis-copied id in step 2.

> **UNKNOWN, the exact on-screen wording and placement of that URL after clicking "Add
> this chatbot" could not be verified**, because it is behind a login wall. Basecamp's
> help article says only *"Each chatbot gets a unique URL that accepts incoming
> payloads"*, with no screenshot and no field label, and the button labels above are
> corroborated by third-party write-ups rather than by a Basecamp page. The API path
> below **is** fully documented and is the reliable fallback.

**Fallback, read the key from the API** (also admin-only), with an OAuth access token:

```bash
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
     -A "commit-relay (jane@example.com)" \
     https://3.basecampapi.com/1234567/buckets/2345678/chats/7654321/integrations.json
```

Each chatbot in the response carries a `lines_url`; extract the key from it exactly as
shown above.

## Step 5: verify. This posts a real message into the room.

```bash
curl -i -X POST \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "User-Agent: commit-relay (jane@example.com)" \
  -d '{"content":"<div dir=\"ltr\"><strong>commit-relay</strong> connected to this room.</div>"}' \
  "https://3.basecampapi.com/1234567/integrations/PLACEHOLDERKEY0123456789/buckets/2345678/chats/7654321/lines.json"
```

| Result | Meaning |
|---|---|
| `HTTP/2 201` | Everything is correct. The message is in the room. |
| `401` or `404` | One of the four values is wrong, or the chatbot was deleted. Basecamp does not say which one, and both statuses have been observed for the same misconfiguration. Recheck all four against the address bar. Do not retry; it will keep failing. |
| `415` | The `Content-Type` header is missing. |
| `429` | Too fast. Wait the number of seconds in the `Retry-After` response header. |

> **The chatbot key is a bearer credential in a URL path.** Anyone holding it can post
> into that room as this bot, with no expiry and no scope. Keep it in an environment
> variable only, never log the full request URL, and revoke it by deleting the chatbot
> and creating a new one, there is no rotation.

## Putting the values into configuration

The preferred form is one secret carrying the whole URL:

```dotenv
BASECAMP_LINES_URL=https://3.basecampapi.com/1234567/integrations/YOUR_KEY/buckets/2345678/chats/7654321/lines.json
```

The four discrete variables are equally supported. Either way, none of them may be
committed, see [Configuration](./configuration.md#basecamp) for the variable table and
[the Cloudflare runbook](./cloudflare-setup.md#5-secrets) for where each one lives on
Workers.

A chatbot lives in exactly one Campfire and its key is minted per chatbot, so a
second room means a second key: see
[per-route targets](./configuration.md#routes--multi-repo-multi-room).

What the posted markup actually is, and which of its attributes Basecamp merely tolerates
rather than documents, is recorded in [the compatibility log](./basecamp-compat.md).
