// Offline stand-in for the Basecamp chatbot lines endpoint (17.1). Node-only:
// scripts/ sits outside src/, so node:* is allowed here.
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { parseLinesUrl } from '../src/config/lines-url.ts';

const PORT = Number(process.env.MOCK_PORT ?? 9999);
const args = process.argv.slice(2);
const htmlIndex = args.indexOf('--html');
const htmlFile = htmlIndex >= 0 ? args[htmlIndex + 1] : undefined;

if (htmlIndex >= 0 && !htmlFile) {
  console.error('usage: node scripts/mock-basecamp.ts [--html <file>]');
  process.exit(2);
}

/** The shape captured from 3.basecampapi.com, sent as two same-named headers. */
function rateLimitHeaders(): string[] {
  const until = new Date(Date.now() + 10_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    `{"name":"API","period":10,"limit":50,"remaining":49,"until":"${until}"}`,
    `{"name":"API_PATH","period":10,"limit":50,"remaining":49,"until":"${until}"}`,
  ];
}

/** A minimal page per posted line, appended so a run of a whole push accumulates. */
function page(content: string): string {
  return `<!doctype html>\n<meta charset="utf-8">\n<div style="font:14px system-ui;max-width:720px;margin:24px auto">\n${content}\n</div>\n`;
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      const raw = Buffer.concat(chunks).toString('utf8');

      if (req.method !== 'POST' || parseLinesUrl(new URL(req.url ?? '/', 'https://3.basecampapi.com').href) === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }

      // Clamped to a real HTTP range: writeHead throws on anything else and the
      // throw would take the whole mock down instead of answering the request.
      const forced = Number(req.headers['x-mock-status'] ?? process.env.MOCK_STATUS ?? '');
      if (Number.isInteger(forced) && forced >= 400 && forced <= 599) {
        // stderr: stdout is reserved for the posted content.
        console.error(`[mock] forcing ${forced}`);
        res.writeHead(forced, {
          'content-type': 'application/json',
          'retry-after': '1',
          'x-ratelimit': rateLimitHeaders(),
        });
        res.end(JSON.stringify({ error: 'forced', status: forced }));
        return;
      }

      let content = raw;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && 'content' in parsed) {
          content = String((parsed as { content: unknown }).content);
        }
      } catch {
        // Not JSON: print whatever arrived, which is itself the interesting signal.
      }

      console.log(content);
      if (htmlFile) await appendFile(htmlFile, page(content), 'utf8');

      res.writeHead(201, {
        'content-type': 'application/json; charset=utf-8',
        'x-ratelimit': rateLimitHeaders(),
      });
      res.end(JSON.stringify({ id: Date.now(), status: 'active' }));
    })();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[mock] basecamp listening on http://127.0.0.1:${PORT}${htmlFile ? ` -> ${htmlFile}` : ''}`);
});
