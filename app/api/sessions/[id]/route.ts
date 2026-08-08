import { NextResponse } from "next/server";
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  listAllSessions,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { deleteAgentTodoFile } from "@/lib/agent-todo-store";
import { createLogger, elapsedMs } from "@/lib/logger";

const log = createLogger("api/sessions/[id]");

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();
  const url = new URL(req.url);
  const includeState = url.searchParams.has("includeState");
  log.debug("get session requested", { id, includeState });
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      log.warn("get session not found", { id, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = SessionManager.open(filePath);
    const entries = sm.getEntries() as never;
    // session_info is display metadata (the session name), not a branch node.
    // Appending one on rename used to pollute the branch tree with a stray
    // node; strip it here (children promoted) and fall the leaf back to a real
    // entry so already-renamed sessions render clean too.
    const tree = stripSessionInfoNodes(sm.getTree());
    const leafId = fallbackSessionLeafId(sm, sm.getLeafId());
    const context = buildSessionContext(entries, leafId);

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const allSessions = await listAllSessions();
    const parentSessionId = allSessions.find((s) => s.id === id)?.parentSessionId;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    } : null;

    let agentState: { running: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        const state = await rpc.send({ type: "get_state" });
        agentState = { running: true, state };
      } else {
        agentState = { running: false };
      }
    }

    log.info("get session completed", {
      id,
      filePath,
      messageCount: context.messages.length,
      includeState,
      agentRunning: agentState?.running,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      tree,
      leafId,
      context,
      ...(agentState !== undefined ? { agentState } : {}),
    });
  } catch (error) {
    log.error("get session failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();
  log.debug("rename session requested", { id });
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      log.warn("rename session rejected", { id, reason: "missing name", durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      log.warn("rename session not found", { id, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // Update the name in place instead of appending a new session_info entry.
    // appendSessionInfo() writes the entry with parentId = current leaf and
    // advances the leaf to it, so renaming used to add a stray node to the
    // branch tree (and, on reload, made later messages hang off it). Rewriting
    // the existing entry keeps the tree structure untouched.
    const cleanName = name.replace(/[\r\n]+/g, " ").trim();
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    let lastInfoIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as { type?: string };
        if (e.type === "session_info") {
          lastInfoIdx = i;
          break;
        }
      } catch {
        /* skip malformed lines */
      }
    }
    if (lastInfoIdx >= 0) {
      const entry = JSON.parse(lines[lastInfoIdx]) as Record<string, unknown>;
      entry.name = cleanName;
      lines[lastInfoIdx] = JSON.stringify(entry);
      // Atomic replace: write a temp file in the same dir, then rename over.
      // Avoids readers (sidebar, GET) observing a truncated file mid-write.
      const tmpPath = `${filePath}.rename.tmp`;
      writeFileSync(tmpPath, lines.join("\n"));
      renameSync(tmpPath, filePath);
    } else {
      // First naming: the session has no session_info entry yet, and the name
      // must live in one for getSessionName()/listAllSessions() to see it.
      const sm = SessionManager.open(filePath);
      sm.appendSessionInfo(cleanName);
    }
    invalidateSessionListCache();
    log.info("rename session completed", {
      id,
      filePath,
      nameLength: name.trim().length,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error("rename session failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// session_info entries are session metadata (name), not conversation branch
// nodes. Strip them out of the branch tree (children promoted to the slot),
// so historical renames don't show up as stray "session_info" nodes.
function stripSessionInfoNodes<T extends { entry: { type?: string }; children: T[] }>(nodes: T[]): T[] {
  const out: T[] = [];
  for (const n of nodes) {
    if (n.entry.type === "session_info") {
      out.push(...stripSessionInfoNodes(n.children));
    } else {
      out.push({ ...n, children: stripSessionInfoNodes(n.children) });
    }
  }
  return out;
}

// When a session_info entry is the last one in the file, reloading makes it
// the leaf; subsequent messages would then hang off the metadata entry. Walk
// back to the nearest real entry so the returned leaf stays a real message.
function fallbackSessionLeafId(
  sm: ReturnType<typeof SessionManager.open>,
  leafId: string | null,
): string | null {
  let cur = leafId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const entry = sm.getEntry(cur);
    if (!entry || (entry as { type?: string }).type !== "session_info") break;
    cur = (entry as { parentId?: string | null }).parentId ?? null;
  }
  return cur;
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();
  log.debug("delete session requested", { id });
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      log.warn("delete session not found", { id, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read header before deleting to get parentSession path
    const firstLine = readFileSync(filePath, "utf8").split("\n")[0];
    let parentSessionPath: string | undefined;
    try {
      const header = JSON.parse(firstLine) as { type?: string; parentSession?: string };
      if (header.type === "session") parentSessionPath = header.parentSession;
    } catch { /* ignore */ }

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    let reparentedChildren = 0;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (header.type === "session" && header.parentSession === filePath) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
            reparentedChildren += 1;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    getRpcSession(id)?.destroy();
    unlinkSync(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    deleteAgentTodoFile(id);
    log.info("delete session completed", {
      id,
      filePath,
      reparentedChildren,
      durationMs: elapsedMs(startedAt),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error("delete session failed", { id, error, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
