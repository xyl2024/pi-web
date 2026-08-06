import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { ensurePathAllowed } from "@/lib/file-access";
import { getRepoStatus } from "@/lib/git-diff";

export const dynamic = "force-dynamic";

const log = createLogger("api/git");

// GET /api/git?cwd=<path>
// Returns the git repo overview for cwd: repo root, branch, and the list of
// changed files with combined staged+unstaged status and +N/-M stats.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  const startedAt = Date.now();

  if (!cwd) {
    log.warn("get git status rejected", { reason: "missing cwd", durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }

  const allowed = await ensurePathAllowed(cwd);
  if (!allowed) {
    log.warn("get git status rejected", { cwd, reason: "cwd not allowed", durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "cwd_not_allowed" }, { status: 403 });
  }

  const status = await getRepoStatus(cwd);
  log.info("get git status completed", {
    cwd,
    repoRoot: status.repoRoot,
    branch: status.branch,
    fileCount: status.files.length,
    durationMs: elapsedMs(startedAt),
  });

  return NextResponse.json(status);
}
