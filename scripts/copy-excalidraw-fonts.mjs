#!/usr/bin/env node
// Fallback script: copies Excalidraw's font assets from node_modules into
// public/ so they're served by Next.js at runtime.
//
// Background: @excalidraw/excalidraw/index.css references font files via
// relative paths. We trust Next.js to resolve them automatically (A1 in the
// integration plan), but if woff2 files 404 in dev or production, run this
// script to copy them locally, then add an `@font-face` override in
// CanvasPanelInner.tsx that points at "/excalidraw-fonts/...".
//
// This script is NOT wired into postinstall — invoke it manually only if A1
// fails. To run:  npm run copy-excalidraw-fonts
//
// Output: public/excalidraw-fonts/<FontName>/<file>.woff2

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const DEST = join(ROOT, "public", "excalidraw-fonts");

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function copyDir(srcDir, destDir) {
  if (!(await exists(srcDir))) {
    console.error(`Source not found: ${srcDir}`);
    console.error("Did you run `npm install`? Is @excalidraw/excalidraw installed?");
    process.exit(1);
  }
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
      count++;
    }
  }
  return count;
}

const n = await copyDir(SRC, DEST);
console.log(`Copied ${n} files from ${relative(ROOT, SRC)} to ${relative(ROOT, DEST)}`);