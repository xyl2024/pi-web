# Vendored webfonts

This directory holds the webfont assets loaded by `app/layout.tsx` via
`next/font/local`. Currently vendored:

- `wenkai-regular.woff2` — LXGW WenKai Regular (proportional / sans)
- `OFL.txt` — SIL Open Font License 1.1 (copy of upstream)

Monospace contexts (code blocks, JSON, file paths, terminal output) use the
system stack starting with `'Consolas'` — see `--font-mono` in
`app/globals.css`.

## Source

LXGW WenKai / 霞鹜文楷 — <https://github.com/lxgw/LxgwWenKai>
Derived from Fontworks' Klee One. SIL OFL 1.1 licensed.

## Why vendored (not Google Fonts CDN)

LXGW WenKai is not on Google Fonts. Vendoring the subsetted WOFF2 files
keeps the build offline and reproducible, and matches the OFL §3 clause that
explicitly permits webfont subsetting and format conversion without renaming.

## Subset coverage

The WOFF2 files contain only the codepoints below (≈ 21 400 characters
total, ~4.7 MB each):

- Basic Latin (U+0020–007F)
- Latin-1 Supplement (U+00A0–00FF)
- General Punctuation (U+2000–206F)
- CJK Symbols and Punctuation (U+3000–303F)
- CJK Unified Ideographs Basic (U+4E00–9FFF)

Codepoints outside this set (Halfwidth/Fullwidth Forms, CJK Extension B+,
archaic characters, etc.) fall through to the system font stack defined in
`app/globals.css` (`-apple-system`, `PingFang SC`, `Microsoft YaHei`, …).

## Rebuilding

When upgrading to a new LXGW WenKai release:

```bash
# 1. Download upstream TTFs into a scratch directory
mkdir -p /tmp/wenkai-src && cd /tmp/wenkai-src
curl -L -O https://github.com/lxgw/LxgwWenKai/releases/latest/download/LXGWWenKai-Regular.ttf
curl -L -O https://github.com/lxgw/LxgwWenKai/releases/latest/download/LXGWWenKaiMono-Regular.ttf
curl -L -O https://raw.githubusercontent.com/lxgw/LxgwWenKai/main/OFL.txt
cd -

# 2. Run the subsetter (uses each font in its own process — see note below)
npx tsx scripts/build-wenkai-fonts.ts
```

The script writes `wenkai-regular.woff2` and `wenkai-mono-regular.woff2`
back into this directory, ready to commit.

**Why two processes?** `subset-font` ships a harfbuzzjs WASM module that
caches a `Uint8Array` view of wasm memory. When a subset triggers wasm
memory growth, the cached view becomes stale and subsequent subsets return
`hb_subset_or_fail` errors. The script avoids this by spawning a fresh
`tsx` process per font — the cleanest workaround without patching the
upstream library.