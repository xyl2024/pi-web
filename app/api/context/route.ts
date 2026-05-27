import { NextResponse } from "next/server";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/context");

// Module-level cache: cwd → { files, expiresAt }
const CONTEXT_CACHE_TTL_MS = 30_000;
type CachedFiles = { files: { path: string; content: string; label: string }[]; expiresAt: number };
const contextCache = new Map<string, CachedFiles>();

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

  const cached = contextCache.get(cwd);
  if (cached && cached.expiresAt > startedAt) {
    log.debug("get context cached", { cwd, fileCount: cached.files.length, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ files: cached.files });
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

    contextCache.set(cwd, { files, expiresAt: startedAt + CONTEXT_CACHE_TTL_MS });
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