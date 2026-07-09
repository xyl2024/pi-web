import { NextResponse } from "next/server";
import { listRunningRpcSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/running
 *
 * Returns the `running` flag for every session currently registered in the
 * in-memory AgentSessionWrapper registry. No disk reads — cheap enough to
 * poll every few seconds from the sidebar without scanning every `.jsonl`.
 *
 * Response: { sessions: [{ id, running }, ...] }
 */
export async function GET() {
  const sessions = listRunningRpcSessions();
  return NextResponse.json({ sessions });
}
