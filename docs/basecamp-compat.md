# Basecamp compatibility log

A dated record of what Basecamp's chatbot endpoint actually does with the markup this
project posts. The message format depends on four attributes that Basecamp neither
permits nor forbids in any primary source: `colspan`, `dir`, `cellpadding`, `nowrap`,
plus the trailing `<br>` in the last cell of every row.

The failure mode is the dangerous one. An unsupported tag or attribute is **silently
stripped and the line still returns 201 Created**. There is no error to observe, and no
automated test can assert it, the check is manual, run against a real Campfire room,
and its result is committed here rather than asserted from a codebase a reader cannot
inspect. **Re-run and re-date it before each major release.**

Related: [Basecamp setup](./basecamp-setup.md) · [Configuration reference](./configuration.md) · [Cloudflare runbook](./cloudflare-setup.md)

## The exact HTML posted

The probe posts precisely this `content`, a three-file commit with stats resolved.
Newlines are shown where they are written; the trailing `<br>\n` inside the last cell of
each row is load-bearing, not cosmetic.

```html
<div dir="ltr"><table dir="ltr" cellpadding="4">
<tbody>
<tr><td nowrap><strong>Repository&nbsp;</strong></td><td>AKMofficial/commit-relay<br>
</td></tr>
<tr><td nowrap><strong>Author&nbsp;</strong></td><td>jane-doe<br>
</td></tr>
<tr><td nowrap><strong>Files&nbsp;</strong></td><td>3<br>
</td></tr>
<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>+42 / -7<br>
</td></tr>
<tr><td colspan="2"><strong>Commit message</strong><br>
</td></tr>
<tr><td colspan="2">Fix crash when the config file is empty<br><a href="https://github.com/AKMofficial/commit-relay/commit/9f2c1ab7e4d5c60318b2ee0a7f13c9d80a4b6e21">View the commit</a><br>
</td></tr>
</tbody>
</table></div>
```

That HTML is the value of the `content` field, not the request body. Write the body to
`probe.json` first, one JSON object, with the HTML above as a single JSON string
(newlines escaped as `\n`):

```json
{"content":"<div dir=\"ltr\"><table dir=\"ltr\" cellpadding=\"4\">\n<tbody>\n<tr><td nowrap><strong>Repository&nbsp;</strong></td><td>AKMofficial/commit-relay<br>\n</td></tr>\n<tr><td nowrap><strong>Author&nbsp;</strong></td><td>jane-doe<br>\n</td></tr>\n<tr><td nowrap><strong>Files&nbsp;</strong></td><td>3<br>\n</td></tr>\n<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>+42 / -7<br>\n</td></tr>\n<tr><td colspan=\"2\"><strong>Commit message</strong><br>\n</td></tr>\n<tr><td colspan=\"2\">Fix crash when the config file is empty<br><a href=\"https://github.com/AKMofficial/commit-relay/commit/9f2c1ab7e4d5c60318b2ee0a7f13c9d80a4b6e21\">View the commit</a><br>\n</td></tr>\n</tbody>\n</table></div>"}
```

Then post it, with the room's own four values substituted into the URL:

```bash
curl -i -X POST \
  -H 'Content-Type: application/json; charset=utf-8' \
  -H 'User-Agent: commit-relay (jane@example.com)' \
  --data-binary @probe.json \
  "https://3.basecampapi.com/1234567/integrations/PLACEHOLDERKEY0123456789/buckets/2345678/chats/7654321/lines.json"
```

## Attributes under probe

Each row is one thing the message format relies on and Basecamp does not document.

| Attribute / construct | Where it is used | What breaks if it is stripped |
|---|---|---|
| `colspan="2"` | The two full-width rows: the `Commit message` label and the message body | The table renders wrong while still returning 201. Fallback layout below |
| `dir="ltr"` | On both the outer `<div>` and the `<table>` | The riskiest of the four. English/LTR output is a hard requirement; direction does not reliably inherit through the sanitizer, and if `dir` is stripped the room's own direction governs. The only remaining lever is U+2066/U+2069 wrapping, which is deferred |
| `cellpadding="4"` | On the `<table>` | All padding. `style` and `class` are assumed stripped, so this is the only padding lever |
| `nowrap` | On every label `<td>` | Labels wrap mid-phrase |
| trailing `<br>\n` in the last cell of every row | Every row | Adjacent rows collapse into each other |

## Probe log

Each entry is one dated run against a real Campfire room. Fill a new row rather than
editing an old one.

| Date | Response status | Response headers | Rendered result |
|---|---|---|---|
| UNVERIFIED: to be run by the maintainer against a real room before v0.1.0 | UNVERIFIED: to be run by the maintainer against a real room before v0.1.0 | UNVERIFIED: to be run by the maintainer against a real room before v0.1.0 | UNVERIFIED: to be run by the maintainer against a real room before v0.1.0 |

**What to record in each column.**

- **Date**: the UTC date the probe was posted.
- **Response status**: the literal status line, e.g. `HTTP/2 201`.
- **Response headers**: the full response headers, including the multi-valued
  `x-ratelimit` header, which is itself undocumented and is what the poster's pacing
  reads.
- **Rendered result**: per attribute: preserved or stripped, judged by reading the
  posted line back and by looking at the room. Attach the screenshot alongside this
  file. Screenshots must be rendered from placeholder data only, never captured from a
  live room carrying real content.

## If `colspan` is ever stripped

The fallback stops asking the table for full-width rows and promotes both full-width
elements to block-level siblings outside it. Every tag and attribute below is on the
**documented** rich-text list:

```html
<div dir="ltr">
<table dir="ltr" cellpadding="4">
<tbody>
<tr><td nowrap><strong>Repository&nbsp;</strong></td><td>AKMofficial/commit-relay<br>
</td></tr>
<tr><td nowrap><strong>Author&nbsp;</strong></td><td>jane-doe<br>
</td></tr>
<tr><td nowrap><strong>Files&nbsp;</strong></td><td>3<br>
</td></tr>
<tr><td nowrap><strong>Changes&nbsp;</strong></td><td>+42 / -7<br>
</td></tr>
</tbody>
</table>
<strong>Commit message</strong><br>
<blockquote>Fix crash when the config file is empty<br><br>Fixes #12<br><a href="https://github.com/AKMofficial/commit-relay/commit/9f2c1ab7e4d5c60318b2ee0a7f13c9d80a4b6e21">View the commit</a><br>
</blockquote>
</div>
```

Row order is preserved: rows 1 to 4 in the table, the label as a `<strong>` strip below
it, the body as a `<blockquote>` below that. Block elements are full-width by nature, so
no attribute is needed. The cost is `cellpadding` and `nowrap` losing their scope over
the label strip, which is cosmetic.

A nested single-column table is the obvious alternative and is **rejected**: nested
tables inside a sanitizer nobody can inspect are strictly more fragile than block
siblings.

The switch is a build-time constant in `src/render/message.ts`, not a runtime config
knob. There is no signal to key it on, a stripped attribute still returns 201, so
exposing it as a knob would only offer a choice nobody can make correctly.
