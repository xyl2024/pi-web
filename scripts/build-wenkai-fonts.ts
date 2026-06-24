// scripts/build-wenkai-fonts.ts
//
// Regenerates the vendored LXGW WenKai webfont in `lib/fonts/` from the
// upstream TTF. Run manually when upgrading to a new LXGW WenKai release;
// not wired into dev/build pipelines.
//
// Usage:
//   1. Download upstream TTF into /tmp/wenkai-src/ (or set WENKAI_SRC_DIR):
//        curl -L -o /tmp/wenkai-src/LXGWWenKai-Regular.ttf \
//          https://github.com/lxgw/LxgwWenKai/releases/latest/download/LXGWWenKai-Regular.ttf
//   2. npx tsx scripts/build-wenkai-fonts.ts
//
// Subset coverage:
//   - Basic Latin (U+0020-007F) incl. digits + ASCII punctuation
//   - Latin-1 Supplement (U+00A0-00FF)
//   - General Punctuation (U+2000-206F)
//   - CJK Symbols and Punctuation (U+3000-303F)
//   - CJK Unified Ideographs Basic (U+4E00-9FFF) — ~21K chars
//
// Intentionally omitted: Halfwidth and Fullwidth Forms (U+FF00-FFEF). These
// forms are rare in chat/UI text and fall through to system fonts
// (PingFang SC / Microsoft YaHei) which contain them.
//
// Rare CJK (Extension B+, archaic characters) also fall through to the system
// font stack defined in app/globals.css.
//
// Note: pi-web uses Consolas (and a system mono fallback chain) for monospace
// contexts — code blocks, JSON, file paths, terminal output. WenKai Mono is
// not vendored; if you ever need it, subset from LXGWWenKaiMono-Regular.ttf
// and update --font-mono in app/globals.css accordingly.

import subsetFont from "subset-font";
import { promises as fs } from "node:fs";
import path from "node:path";

const SRC_DIR = process.env.WENKAI_SRC_DIR ?? "/tmp/wenkai-src";
const OUT_DIR = "lib/fonts";

const RANGES: Array<[number, number]> = [
  [0x0020, 0x007f], // Basic Latin
  [0x00a0, 0x00ff], // Latin-1 Supplement
  [0x2000, 0x206f], // General Punctuation
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x4e00, 0x9fff], // CJK Unified Ideographs Basic
];

function buildSubsetText(): string {
  let s = "";
  for (const [start, end] of RANGES) {
    for (let cp = start; cp <= end; cp++) {
      s += String.fromCodePoint(cp);
    }
  }
  return s;
}

const SRC_FILE = "LXGWWenKai-Regular.ttf";
const OUT_FILE = "wenkai-regular.woff2";

async function subsetOne(): Promise<void> {
  const input = path.join(SRC_DIR, SRC_FILE);
  const output = path.join(OUT_DIR, OUT_FILE);

  try {
    await fs.access(input);
  } catch {
    throw new Error(
      `Missing source font: ${input}\n` +
        `Download upstream TTF into ${SRC_DIR}/ first.`,
    );
  }

  const text = buildSubsetText();
  console.log(`Subset character set: ${text.length} code points`);

  await fs.mkdir(OUT_DIR, { recursive: true });

  process.stdout.write(`Subsetting ${SRC_FILE} -> ${OUT_FILE} ... `);
  const t0 = Date.now();
  const inputBuffer = await fs.readFile(input);
  const outputBuffer = await subsetFont(inputBuffer, text, {
    targetFormat: "woff2",
  });
  await fs.writeFile(output, outputBuffer);
  const { size } = await fs.stat(output);
  const ms = Date.now() - t0;
  console.log(
    `done (${(size / 1024 / 1024).toFixed(2)} MB in ${ms} ms)`,
  );
}

async function main(): Promise<void> {
  await subsetOne();
  console.log("\nReload Next.js (npm run dev) to pick up the new font file.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});