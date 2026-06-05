/**
 * POST /api/weixin/login
 *   body: (none)
 *   response: { sessionKey, qrDataUrl, qrUrl, expiresAt }
 *
 *   Starts a new QR login: calls get_bot_qrcode, renders the returned
 *   weixin:// URL as a PNG data URL, and stores the session for polling.
 *
 * GET /api/weixin/login?sessionKey=…
 *   response: { phase, message, account? } | { error: "expired" }
 *
 *   Polled by the UI to advance the login state machine.
 *   Internally calls get_qrcode_status on each request.
 */
import { NextResponse } from "next/server";
import { state, api, qr } from "@/lib/wechat";
import type { LoginSession } from "@/lib/wechat";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/weixin/login");

const DEFAULT_BOT_TYPE = "3";
const SESSION_TTL_MS = 5 * 60 * 1000;

export async function POST() {
  const startedAt = Date.now();
  try {
    const fetched = await api.fetchQrCode(DEFAULT_BOT_TYPE);
    if (!fetched.qrcode || !fetched.qrcode_img_content) {
      return NextResponse.json({ error: "Failed to obtain QR code from server" }, { status: 502 });
    }

    const session = state.createSession({
      qrcodeUrl: fetched.qrcode_img_content,
      qrcode: fetched.qrcode,
      baseUrl: "https://ilinkai.weixin.qq.com",
      botType: DEFAULT_BOT_TYPE,
    });

    const qrDataUrl = await qr.toDataUrl(fetched.qrcode_img_content);

    log.info("qr session created", { sessionKey: session.sessionKey, durationMs: elapsedMs(startedAt) });
    return NextResponse.json({
      sessionKey: session.sessionKey,
      qrDataUrl,
      qrUrl: fetched.qrcode_img_content,
      expiresAt: session.startedAt + SESSION_TTL_MS,
    });
  } catch (err) {
    log.error("start login failed", { error: String(err), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const sessionKey = url.searchParams.get("sessionKey");
  if (!sessionKey) {
    return NextResponse.json({ error: "sessionKey required" }, { status: 400 });
  }

  const session = state.getSession(sessionKey);
  if (!session) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  // Only poll upstream if we haven't reached a terminal state.
  let working = session;
  if (session.phase === "waiting" || session.phase === "scanned" || session.phase === "verifying" ||
      session.phase === "redirected" || session.phase === "verify_blocked") {
    try {
      const status = await api.pollQrStatus(
        session.baseUrl,
        session.qrcode,
        session.pendingVerifyCode,
      );

      // Clear the verify code after it's been submitted.
      if (session.pendingVerifyCode) {
        state.updateSession(sessionKey, { pendingVerifyCode: undefined });
      }

      working = advancePhase(session, status);
    } catch (err) {
      log.warn("poll failed", { sessionKey, error: String(err) });
    }
  }

  log.debug("login poll", {
    sessionKey,
    phase: working.phase,
    durationMs: elapsedMs(startedAt),
  });

  return NextResponse.json({
    phase: working.phase,
    message: working.message,
    account: working.account
      ? { accountId: working.account.accountId, userId: working.account.userId }
      : undefined,
  });
}

function advancePhase(
  session: LoginSession,
  status: { status: string; bot_token?: string; ilink_bot_id?: string; baseurl?: string; ilink_user_id?: string; redirect_host?: string },
): LoginSession {
  const key = session.sessionKey;
  const set = (patch: Partial<LoginSession>): LoginSession => state.updateSession(key, patch) ?? session;

  switch (status.status) {
    case "wait":
      return set({ phase: "waiting" });
    case "scaned":
      return set({ phase: "scanned" });
    case "need_verifycode":
      return set({ phase: "verifying", message: "需要输入配对码" });
    case "verify_code_blocked":
      return set({ phase: "verify_blocked", message: "多次输入错误，请刷新二维码" });
    case "scaned_but_redirect": {
      const newBase = status.redirect_host ? `https://${status.redirect_host}` : session.baseUrl;
      return set({ phase: "redirected", baseUrl: newBase });
    }
    case "expired":
      return set({ phase: "expired", message: "二维码已过期" });
    case "binded_redirect":
      return set({ phase: "already_bound", message: "此 OpenClaw 已绑定该微信账号" });
    case "confirmed": {
      if (!status.bot_token || !status.ilink_bot_id) {
        return set({ phase: "error", message: "服务器未返回凭据" });
      }
      const account = {
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl || session.baseUrl,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
        status: "ok" as const,
      };
      state.saveAccount(account);
      // Best-effort notify start so the bot shows online immediately.
      api.notifyStart({ baseUrl: account.baseUrl, token: account.token }).catch(() => {});
      return set({ phase: "confirmed", account });
    }
    default:
      return session;
  }
}
