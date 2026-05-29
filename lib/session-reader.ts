import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { SessionManager, buildSessionContext as piBuildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionInfo, SessionContext, SessionTreeNode, AssistantMessage, SessionSearchResult, SessionSearchResponse } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";

export { getAgentDir };

export function getSessionsDir(): string {
  return `${getAgentDir()}/sessions`;
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  const cache = getPathCache();
  return piSessions.map((s) => {
    // Populate path cache so resolveSessionPath works without a full scan
    cache.set(s.id, s.path);
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
    };
  });
}

// ============================================================================
// Session path cache: sessionId → absolute file path
// Stored in globalThis for hot-reload safety
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  getPathCache().set(sessionId, filePath);
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodeMap = new Map<string, SessionTreeNode>();
  const labelsById = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type === "label") {
      const l = entry as { type: "label"; targetId: string; label?: string };
      if (l.label) labelsById.set(l.targetId, l.label);
      else labelsById.delete(l.targetId);
    }
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodeMap.set(entry.id, { entry, children: [], label: labelsById.get(entry.id) });
  }
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    if (!entry.parentId) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
    stack.push(...node.children);
  }
  return roots;
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Find the last compaction on path (mirrors pi's buildSessionContext logic)
  let compactionId: string | undefined;
  let firstKeptEntryId: string | undefined;
  for (const e of path) {
    if (e.type === "compaction") {
      compactionId = e.id;
      firstKeptEntryId = (e as { firstKeptEntryId: string }).firstKeptEntryId;
    }
  }

  const entryIds: string[] = [];
  if (compactionId) {
    // The first message in piCtx.messages is the synthetic compaction summary — map to compaction entry id
    entryIds.push(compactionId);
    const compactionIdx = path.findIndex((e) => e.id === compactionId);
    const firstKeptIdx = firstKeptEntryId
      ? path.findIndex((e, i) => i < compactionIdx && e.id === firstKeptEntryId)
      : -1;
    const startIdx = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx;
    for (let i = startIdx; i < compactionIdx; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
  } else {
    for (const e of path) {
      if (e.type === "message") entryIds.push(e.id);
    }
  }

  // pi injects compaction summary as {role:"compactionSummary", summary, tokensBefore}.
  // Convert to {role:"user"} so MessageView can render it the same as before.
  const messages = (piCtx.messages as AssistantMessage[]).map((msg) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.role === "compactionSummary") {
      return {
        role: "user" as const,
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      };
    }
    return normalizeToolCalls(msg);
  });

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}

// ============================================================================
// Session search: full-text search over user + assistant messages
// ============================================================================

function workspaceSlug(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
}

function extractMessageContent(msg: Record<string, unknown>): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(" ");
  }
  return "";
}

function buildSnippet(content: string, lowerQuery: string): string {
  const lowerContent = content.toLowerCase();
  const idx = lowerContent.indexOf(lowerQuery);
  if (idx === -1) return content.slice(0, 120) + "...";

  const qlen = lowerQuery.length;
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + qlen + 60);

  let snippet = "";
  if (start > 0) snippet += "...";
  snippet += content.slice(start, idx);
  snippet += "\u0000" + content.slice(idx, idx + qlen) + "\u0000";
  snippet += content.slice(idx + qlen, end);
  if (end < content.length) snippet += "...";

  return snippet;
}

async function searchFile(filePath: string, lowerQuery: string): Promise<SessionSearchResult | null> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    let sessionId = "";
    let cwd = "";
    let name: string | undefined;
    let matchCount = 0;
    let snippet = "";
    let foundSnippet = false;
    let firstMatchEntryId: string | undefined;

    rl.on("line", (line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;

        if (entry.type === "session") {
          sessionId = (entry.id as string) ?? "";
          cwd = (entry.cwd as string) ?? "";
        }

        // Match session name
        if (entry.type === "session_info" && entry.name) {
          name = entry.name as string;
          if (name.toLowerCase().includes(lowerQuery)) {
            matchCount++;
            if (!foundSnippet) {
              snippet = buildSnippet(name, lowerQuery);
              foundSnippet = true;
            }
          }
        }

        // Match user / assistant message content
        if (entry.type === "message") {
          const msg = entry.message as Record<string, unknown> | undefined;
          if (msg && (msg.role === "user" || msg.role === "assistant")) {
            const content = extractMessageContent(msg);
            if (content && content.toLowerCase().includes(lowerQuery)) {
              matchCount++;
              if (!foundSnippet) {
                snippet = buildSnippet(content, lowerQuery);
                foundSnippet = true;
                firstMatchEntryId = entry.id as string | undefined;
              }
            }
          }
        }
      } catch {
        // Skip malformed JSON lines
      }
    });

    rl.on("close", () => {
      if (matchCount === 0) {
        resolve(null);
        return;
      }
      const stat = fs.statSync(filePath);
      resolve({
        id: sessionId,
        name,
        cwd,
        modified: stat.mtime.toISOString(),
        matchCount,
        snippet,
        firstMatchEntryId,
      });
    });

    rl.on("error", reject);
  });
}

export async function searchSessions(cwd: string, query: string): Promise<SessionSearchResponse> {
  const sessionsDir = getSessionsDir();
  const slug = workspaceSlug(cwd);
  const workspaceDir = path.join(sessionsDir, slug);

  if (!fs.existsSync(workspaceDir)) {
    return { results: [], hasMore: false };
  }

  const files = fs.readdirSync(workspaceDir).filter((f) => f.endsWith(".jsonl"));
  const lowerQuery = query.toLowerCase();

  const results: SessionSearchResult[] = [];
  for (const file of files) {
    const filePath = path.join(workspaceDir, file);
    const result = await searchFile(filePath, lowerQuery);
    if (result) results.push(result);
  }

  // Sort by modified descending (most recently active first)
  results.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  const MAX_RESULTS = 20;
  const hasMore = results.length > MAX_RESULTS;
  return {
    results: results.slice(0, MAX_RESULTS),
    hasMore,
  };
}



