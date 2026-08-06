import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { ensurePathAllowed } from "@/lib/file-access";
import { getFileDiff, getRepoRoot } from "@/lib/git-diff";

export const dynamic = "force-dynamic";

const log = createLogger("api/git/diff");

// GET /api/git/diff?cwd=<path>&file=<rel-path>&staged=<0|1>
// Returns the unified diff for one file. `cwd` must be an allowed root;
// `file` is relative to the repo root (never user-visible in a path — it is
// passed to git as a literal argument, so `..` traversal is harmless, but
// we still restrict the repo itself to an allowed root).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  const file = searchParams.get("file");
  const stagedParam = searchParams.get("staged");
  const startedAt = Date.now();

  if (!cwd || !file) {
    log.warn("get git diff rejected", { reason: "missing cwd or file", durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "cwd and file required" }, { status: 400 });
  }
  const staged = stagedParam === "1";

  const allowed = await ensurePathAllowed(cwd);
  if (!allowed) {
    log.warn("get git diff rejected", { cwd, reason: "cwd not allowed", durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "cwd_not_allowed" }, { status: 403 });
  }

  const repoRoot = await getRepoRoot(cwd);
  if (!repoRoot) {
    return NextResponse.json({ diff: null, truncated: false }, { status: 200 });
  }

  const { diff, truncated } = await getFileDiff(repoRoot, file, staged);
  log.info("get git diff completed", {
    cwd, file, staged, repoRoot,
    bytes: diff?.length ?? 0,
    truncated,
    durationMs: elapsedMs(startedAt),
  });

  return NextResponse.json({ diff, truncated });
}
