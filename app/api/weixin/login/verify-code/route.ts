/**
 * POST /api/weixin/login/verify-code
 *   body: { sessionKey, code }
 *
 *   Stores the user-entered pairing code on the session. The next poll
 *   by GET /api/weixin/login will pass it to get_qrcode_status.
 */
import { NextResponse } from "next/server";
import { state } from "@/lib/wechat";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/weixin/login/verify-code");

export async function POST(req: Request) {
  let body: { sessionKey?: string; code?: string };
  try {
    body = (await req.json()) as { sessionKey?: string; code?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { sessionKey, code } = body;
  if (!sessionKey || typeof sessionKey !== "string") {
    return NextResponse.json({ error: "sessionKey required" }, { status: 400 });
  }
  if (!code || typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }

  const session = state.getSession(sessionKey);
  if (!session) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  state.updateSession(sessionKey, { pendingVerifyCode: code.trim() });
  log.info("verify code queued", { sessionKey });
  return NextResponse.json({ ok: true });
}
