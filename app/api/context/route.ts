import { NextResponse } from "next/server";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/context");

// GET /api/context?cwd=<path>
// Returns all AGENTS.md files discovered by DefaultResourceLoader
// (project-level walking up from cwd + global at agentDir)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  const startedAt = Date.now();

  if (!cwd) {
    log.warn("get context rejected", { reason: "missing cwd", durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }

  try {
    log.debug("get context requested", { cwd });
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();

    const { agentsFiles } = loader.getAgentsFiles();
    const files = agentsFiles.map((f) => ({
      path: f.path,
      content: f.content,
      // Label for display: filename or relative path from cwd
      label: f.path.split("/").pop() ?? f.path,
    }));

    log.info("get context completed", {
      cwd,
      fileCount: files.length,
      paths: files.map((f) => f.path),
      durationMs: elapsedMs(startedAt),
    });

    return NextResponse.json({ files });
  } catch (error) {
    log.error("get context failed", { cwd, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}