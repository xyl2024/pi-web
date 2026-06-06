/**
 * GET  /api/weixin/workspace
 *   response: {
 *     currentWorkspaceId: string | null,
 *     currentSessionId:   string | null,
 *     pinnedCwds:         string[],
 *     recentCwds:         string[],   // unpinned, most recent first
 *   }
 *
 *   Lists the workspaces available to the WeChat channel. Reuses
 *   /api/sessions and /api/pinned-cwds for data so the panel stays
 *   in sync with the sidebar's project picker (Wk1).
 *
 * POST /api/weixin/workspace
 *   body:    { workspaceId: string }
 *   response: { currentWorkspaceId, currentSessionId }
 *
 *   L2 cold-start semantics: switching workspace clears currentSessionId.
 *   The next inbound message will spawn a new session in the new workspace.
 *   A 400 is returned if no account is configured.
 */
import { NextResponse } from "next/server";
import { state } from "@/lib/wechat";

export const dynamic = "force-dynamic";

interface SessionRow {
  id: string;
  cwd: string;
  modified: string;
}

async function fetchSessions(origin: string): Promise<SessionRow[]> {
  try {
    const res = await fetch(`${origin}/api/sessions`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions?: SessionRow[] };
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

async function fetchPinnedCwds(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/api/pinned-cwds`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { cwds?: string[] };
    return Array.isArray(data.cwds) ? data.cwds : [];
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  // Self-fetch back into the same Next.js server — use the request's own
  // origin so this works regardless of the listening port (dev=30141,
  // prod=14514, etc.). Falling back to a hardcoded port silently breaks
  // workspace listing on any non-30141 deployment.
  const origin = new URL(req.url).origin;
  const account = state.loadAccount();
  const [sessions, pinnedCwds] = await Promise.all([fetchSessions(origin), fetchPinnedCwds(origin)]);

  // Recent = most-recently-active cwd across all sessions, unpinned.
  const latestByCwd = new Map<string, string>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const prev = latestByCwd.get(s.cwd);
    if (!prev || s.modified > prev) latestByCwd.set(s.cwd, s.modified);
  }
  const recentCwds = [...latestByCwd.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([cwd]) => cwd)
    .filter((c) => !pinnedCwds.includes(c));

  return NextResponse.json({
    currentWorkspaceId: account?.currentWorkspaceId ?? null,
    currentSessionId: account?.currentSessionId ?? null,
    pinnedCwds,
    recentCwds,
  });
}

export async function POST(req: Request) {
  const account = state.loadAccount();
  if (!account) {
    return NextResponse.json({ error: "not_configured" }, { status: 400 });
  }
  let body: { workspaceId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }
  const next = state.setCurrentWorkspace(workspaceId);
  if (!next) {
    return NextResponse.json({ error: "account_lost" }, { status: 500 });
  }
  return NextResponse.json({
    currentWorkspaceId: next.currentWorkspaceId ?? null,
    currentSessionId: next.currentSessionId ?? null,
  });
}
