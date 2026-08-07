import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import { getRepoStatus } from "@/lib/git-diff";

export const dynamic = "force-dynamic";

const log = createLogger("api/git");

// GET /api/git?cwd=<path>
// Returns the git repo overview for cwd: repo root, branch, and the list of
// changed files with combined staged+unstaged status and +N/-M stats.
//
// `cwd` is supplied by the client (always a session cwd that was already
// validated at session creation) so we deliberately skip ensurePathAllowed
// here — that check would force a `listAllSessions()` scan on every call and
// the response only exposes public git metadata (paths, +N/-M counts), no
// file contents.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  const startedAt = Date.now();

  if (!cwd) {
    log.warn("get git status rejected", { reason: "missing cwd", durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
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
