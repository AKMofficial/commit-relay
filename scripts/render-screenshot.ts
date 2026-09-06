// Renders the golden fixture into docs/media/message.png. Placeholder data only:
// a live-room screenshot would carry avatars, the account id and metadata (18.2).
import { deflateSync, inflateSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommitTable, type CommitView } from '../src/render/message.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outFile = join(repoRoot, 'docs', 'media', 'message.png');

/** The 2.2 worked example, verbatim: the only data this image is ever built from. */
const view: CommitView = {
  repoFullName: 'your-org/your-repo',
  refKind: 'branch',
  refName: 'main',
  author: 'jane-doe',
  fileCount: 3,
  additions: 42,
  deletions: 7,
  message:
    'Fix crash when the config file is empty\n\n' +
    'The loader assumed `routes` was always an array, so an empty\n' +
    'config.json threw before validation could report it.\n\n\n\n' +
    'Fixes #12',
  commitUrl: 'https://github.com/your-org/your-repo/commit/9f2c1ab7e4d5c60318b2ee0a7f13c9d80a4b6e21',
};

const SCALE = 2;
const WIDTH = 640;
const HEIGHT = 900;
const BG = { r: 0xf7, g: 0xf6, b: 0xf3 };

const content = buildCommitTable(view, {
  bodyMaxCodePoints: 2_000,
  contentMaxBytes: 16_384,
  webOrigin: 'https://github.com',
});

const page = `<!doctype html>
<meta charset="utf-8">
<title>commit-relay</title>
<style>
  html, body { margin: 0; background: #f7f6f3; }
  body {
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1b19;
    padding: 24px;
  }
  .message { display: flex; gap: 12px; align-items: flex-start; }
  .avatar {
    width: 40px; height: 40px; flex: 0 0 40px; border-radius: 50%;
    background: #d8d4cb; color: #55524b;
    display: flex; align-items: center; justify-content: center;
    font-weight: 600; font-size: 15px;
  }
  .body { min-width: 0; }
  .who { font-weight: 600; margin-bottom: 4px; }
  .when { font-weight: 400; color: #8a867d; margin-left: 8px; font-size: 13px; }
  table { border-collapse: collapse; }
  td { vertical-align: top; padding: 2px 10px 2px 0; }
  a { color: #1d68b3; }
</style>
<div class="message">
  <div class="avatar">cr</div>
  <div class="body">
    <div class="who">commitrelay<span class="when">9:41am</span></div>
    ${content}
  </div>
</div>
`;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  const candidates = fromEnv ? [fromEnv, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    'no Chrome, Chromium or Edge binary found. Set CHROME_PATH to one, or install Google Chrome.',
  );
}

// ── PNG ───────────────────────────────────────────────────────────────────────
// Decoding, cropping and re-encoding from scratch is what guarantees the committed
// file carries no metadata: only IHDR, IDAT and IEND are ever written back.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

interface Raster {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer; // unfiltered, 8 bits per channel
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(file: Buffer): Raster {
  let offset = 8; // signature
  let header: { width: number; height: number; channels: number } | null = null;
  const idat: Buffer[] = [];

  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;

    if (type === 'IHDR') {
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG: depth ${bitDepth}, color type ${colorType}`);
      }
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), channels: colorType === 6 ? 4 : 3 };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!header) throw new Error('PNG has no IHDR');

  const { width, height, channels } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      let value = line[x]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function encodePng(img: Raster): Buffer {
  const stride = img.width * img.channels;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    img.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = img.channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Last row carrying anything other than the page background, plus the same
 *  padding the page uses, so the image ends where the message ends. */
function cropToContent(img: Raster): Raster {
  const stride = img.width * img.channels;
  let lastDrawn = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = y * stride + x * img.channels;
      if (img.pixels[i] !== BG.r || img.pixels[i + 1] !== BG.g || img.pixels[i + 2] !== BG.b) {
        lastDrawn = y;
        break;
      }
    }
  }
  const height = Math.min(img.height, lastDrawn + 24 * SCALE);
  return { ...img, height, pixels: img.pixels.subarray(0, stride * height) };
}

// ── run ───────────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'commit-relay-shot-'));
try {
  const htmlFile = join(work, 'message.html');
  writeFileSync(htmlFile, page, 'utf8');

  const shot = join(work, 'shot.png');
  // Headless Chrome writes the screenshot and then keeps the browser alive, so
  // this waits for a settled file and kills it rather than waiting for an exit.
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--virtual-time-budget=3000',
      `--user-data-dir=${join(work, 'profile')}`,
      `--screenshot=${shot}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      `--force-device-scale-factor=${SCALE}`,
      `file://${htmlFile}`,
    ],
    { stdio: 'ignore' },
  );

  const deadline = Date.now() + 60_000;
  let size = -1;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error('Chrome did not produce a screenshot within 60s');
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!existsSync(shot)) continue;
      const current = statSync(shot).size;
      if (current > 0 && current === size) break;
      size = current;
    }
  } finally {
    chrome.kill('SIGKILL');
  }

  mkdirSync(dirname(outFile), { recursive: true });
  const cropped = cropToContent(decodePng(readFileSync(shot)));
  writeFileSync(outFile, encodePng(cropped));
  console.error(`wrote ${outFile} (${cropped.width}x${cropped.height})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
