// Server-only helper: export a session to HTML using pi coding agent's
// built-in /export command implementation.
//
// Why this file exists
// --------------------
// `@earendil-works/pi-coding-agent` ships an HTML exporter at
// `dist/core/export-html/index.js` that is consumed by its TUI's `/export`
// command. The module is NOT exposed through the package's `exports` field
// (only `.` and `./rpc-entry` are), so a normal subpath import fails with
// `ERR_PACKAGE_PATH_NOT_EXPORTED`. We work around this by:
//
//   1. Walking up from `process.cwd()` to locate the package's
//      `dist/core/export-html/index.js` on disk. Pure filesystem search —
//      no `import.meta.resolve`, no `require.resolve`, both of which are
//      blocked (the former by Next.js's `import.meta` polyfill, the
//      latter by the package's `exports` allowlist).
//   2. Loading the file via `import()` wrapped in `new Function(...)`.
//      This is the only form that survives Next.js's bundler: a literal
//      `import("...")` or `require("...")` of an absolute, dynamic path
//      is rejected as `<dynamic>` (see Next.js's "Module not found:
//      Can't resolve <dynamic>" error). Hiding the call behind
//      `new Function` keeps it opaque to both webpack and turbopack.
//
// The exporter writes its result to disk via `writeFileSync`; we redirect
// it to a tmp file, read the file back, and unlink the file. The returned
// string is the same self-contained HTML pi's TUI produces.
//
// Leaf switching
// --------------
// pi's exporter reads the current leaf from `sm.getLeafId()`. The
// SessionManager class only exposes `resetLeaf()` publicly — there is no
// `setLeaf(id)`. The `leafId` field is `private` in the type definition
// but a plain JS property at runtime, so we mutate it directly. This is
// the same trick pi itself uses internally in `navigate_tree` etc.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

interface PiExportOptions {
  outputPath?: string;
  themeName?: string;
}

interface PiExportModule {
  exportSessionToHtml(
    sm: SessionManager,
    state?: unknown,
    options?: PiExportOptions | string,
  ): Promise<string>;
}

let cachedModule: PiExportModule | null = null;
let cachedPromise: Promise<PiExportModule> | null = null;

const PI_PACKAGE_REL = join(
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "export-html",
  "index.js",
);

// Walk up from cwd looking for the package on disk. Standard
// node_modules resolution: npm/pnpm/yarn all put a flat or hoisted
// `node_modules/` somewhere above the project root, and we cap at 8
// levels which covers any realistic layout (including nested monorepo
// workspaces).
function findPiExportHtmlPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, PI_PACKAGE_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate @earendil-works/pi-coding-agent/${PI_PACKAGE_REL} from ${process.cwd()}`,
  );
}

function loadPiExportModule(): Promise<PiExportModule> {
  if (cachedModule) return Promise.resolve(cachedModule);
  if (cachedPromise) return cachedPromise;
  const path = findPiExportHtmlPath();
  // `new Function` keeps the dynamic `import()` opaque to webpack and
  // turbopack, both of which reject a literal `import("/abs/path")` of
  // a path they cannot statically resolve. At runtime in Node.js 22+,
  // `import` is a global function, so this just loads the ESM module
  // from the absolute path and bypasses pi's `exports` allowlist.
  const dynamicImport = new Function(
    "p",
    "return import(p);",
  ) as (p: string) => Promise<PiExportModule>;
  cachedPromise = dynamicImport(path).then((mod) => {
    cachedModule = mod;
    return mod;
  });
  return cachedPromise;
}

export interface ExportSessionHtmlOptions {
  /**
   * Switch the SessionManager to this leaf id before exporting. Pass
   * `null`/omit to use the SessionManager's current leaf (the default
   * leaf right after `SessionManager.open()`).
   */
  leafId?: string | null;
  /** Theme name from pi's theme registry (e.g. "dark", "light"). */
  themeName?: string;
}

/**
 * Render the given SessionManager's active leaf to a self-contained HTML
 * string using pi's built-in exporter. The string can be streamed into a
 * `NextResponse` as `text/html; charset=utf-8`.
 */
export async function exportSessionHtmlViaPi(
  sm: SessionManager,
  options: ExportSessionHtmlOptions = {},
): Promise<string> {
  const { exportSessionToHtml } = await loadPiExportModule();

  if (options.leafId != null) {
    // `leafId` is private in the type but a plain JS property at runtime.
    // The exporter reads it via `sm.getLeafId()`, so this is the supported
    // way to drive an export of a non-default leaf from outside the class.
    (sm as unknown as { leafId: string | null }).leafId = options.leafId;
  }

  const tmpPath = join(
    tmpdir(),
    `pi-work-export-${randomBytes(8).toString("hex")}.html`,
  );

  try {
    await exportSessionToHtml(sm, undefined, {
      outputPath: tmpPath,
      themeName: options.themeName,
    });
    return readFileSync(tmpPath, "utf8");
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — a leftover tmp file is harmless and
      // OS-bounded to /tmp.
    }
  }
}