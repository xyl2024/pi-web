/**
 * POST /api/weixin/inbound
 *   body:    { fromUserId: string; text: string; contextToken?: string }
 *   response: { ok: true }
 *
 *   Thin HTTP wrapper around lib/wechat/inbound.handleInbound.
 *   In normal operation the background monitor calls handleInbound
 *   directly (in-process), so this endpoint is mostly for testing
 *   and future external triggers.
 */
import { NextResponse } from "next/server";
import { handleInbound } from "@/lib/wechat/inbound";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { fromUserId?: unknown; text?: unknown; contextToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const fromUserId = typeof body.fromUserId === "string" ? body.fromUserId : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!fromUserId || !text) {
    return NextResponse.json({ ok: false, error: "fromUserId and text required" }, { status: 400 });
  }
  const contextToken = typeof body.contextToken === "string" ? body.contextToken : undefined;
  // Don't await — the reply is async, but the inbound handler already
  // does its own error reporting back to the user.
  void handleInbound({ fromUserId, text, contextToken });
  return NextResponse.json({ ok: true });
}
