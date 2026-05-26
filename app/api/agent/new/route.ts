import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { startRpcSession } from "@/lib/rpc-manager";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/agent/new");

// POST /api/agent/new  body: { cwd: string; type: string; message: string; ... }
// Spawns a brand-new pi session and immediately sends the first command.
// Returns { sessionId, data } where sessionId is pi's real session id.
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    const commandType = typeof command.type === "string" ? command.type : "unknown";
    log.info("new agent session requested", {
      cwd,
      commandType,
      provider: typeof command.provider === "string" ? command.provider : undefined,
      modelId: typeof command.modelId === "string" ? command.modelId : undefined,
      toolCount: Array.isArray(command.toolNames) ? command.toolNames.length : undefined,
      thinkingLevel: typeof command.thinkingLevel === "string" ? command.thinkingLevel : undefined,
    });

    if (!cwd || typeof cwd !== "string") {
      log.warn("new agent session rejected", { reason: "missing cwd", durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      log.warn("new agent session rejected", { cwd, reason: "cwd not found", durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; [key: string]: unknown };

    const tempKey = `__new__${Date.now()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames);

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    globalThis.__piAllowedRootsCache?.roots.add(cwd);

    // Apply pre-selected model before sending the prompt
    if (provider && modelId) {
      await session.send({ type: "set_model", provider, modelId });
    }

    // Apply pre-selected thinking level before sending the prompt
    if (thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: thinkingLevel });
    }

    const result = await session.send(promptCommand);

    log.info("new agent session completed", {
      cwd,
      sessionId: realSessionId,
      commandType,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ success: true, sessionId: realSessionId, data: result });
  } catch (error) {
    log.error("new agent session failed", { error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
