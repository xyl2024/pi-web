/**
 * GET /api/weixin/status
 *
 * Returns the current wechat account state for the UI:
 *   { configured: false }                                  — no account
 *   { configured: true, accountId, userId, baseUrl, ... }  — logged in
 */
import { NextResponse } from "next/server";
import { state } from "@/lib/wechat";

export const dynamic = "force-dynamic";

export async function GET() {
  const account = state.loadAccount();
  if (!account) {
    return NextResponse.json({ configured: false });
  }
  return NextResponse.json({
    configured: true,
    accountId: account.accountId,
    userId: account.userId ?? null,
    baseUrl: account.baseUrl,
    savedAt: account.savedAt,
    status: account.status ?? "ok",
    currentWorkspaceId: account.currentWorkspaceId ?? null,
    currentSessionId: account.currentSessionId ?? null,
  });
}
