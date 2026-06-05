/**
 * POST /api/weixin/test-send
 *   body: { to: string, text: string, contextToken?: string }
 *   response: { ok: true, messageId } | { error }
 *
 *   Sends a single text message downstream. Requires an account to be
 *   configured (QR login completed). No inbound flow — caller supplies
 *   the recipient's @im.wechat user id manually.
 */
import { NextResponse } from "next/server";
import { state, api } from "@/lib/wechat";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/weixin/test-send");

export async function POST(req: Request) {
  const startedAt = Date.now();
  let body: { to?: string; text?: string; contextToken?: string };
  try {
    body = (await req.json()) as { to?: string; text?: string; contextToken?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const to = (body.to ?? "").trim();
  const text = (body.text ?? "").trim();

  if (!to) {
    return NextResponse.json({ error: "Recipient (to) is required" }, { status: 400 });
  }
  if (!to.endsWith("@im.wechat")) {
    return NextResponse.json(
      { error: "Recipient must be a WeChat user id (must end with @im.wechat)" },
      { status: 400 },
    );
  }
  if (!text) {
    return NextResponse.json({ error: "Message text is required" }, { status: 400 });
  }

  const account = state.loadAccount();
  if (!account) {
    return NextResponse.json(
      { error: "No WeChat account configured. Please scan to log in first." },
      { status: 401 },
    );
  }

  const clientId = api.newClientId();
  try {
    const resp = await api.sendTextMessage({
      baseUrl: account.baseUrl,
      token: account.token,
      to,
      text,
      contextToken: body.contextToken,
      clientId,
    });
    if (resp.ret !== undefined && resp.ret !== 0) {
      log.warn("sendmessage non-zero ret", { to, ret: resp.ret, errmsg: resp.errmsg });
      return NextResponse.json(
        { error: resp.errmsg || `Server returned ret=${resp.ret}` },
        { status: 502 },
      );
    }
    log.info("message sent", { to, clientId, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ ok: true, messageId: clientId });
  } catch (err) {
    log.error("send failed", { to, error: String(err), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
