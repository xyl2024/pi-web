/**
 * POST /api/weixin/logout
 *   body: (none)
 *
 *   Clears the persisted account and best-effort notifies the server
 *   that the bot is going offline.
 */
import { NextResponse } from "next/server";
import { state, api, monitor } from "@/lib/wechat";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/weixin/logout");

export async function POST() {
  const account = state.loadAccount();
  state.clearAccount();
  if (account) {
    state.clearContacts(account.accountId);
  }
  monitor.stopMonitor();
  if (account?.token) {
    try {
      await api.notifyStop({ baseUrl: account.baseUrl, token: account.token });
    } catch (err) {
      log.warn("notifyStop failed (ignored)", { error: String(err) });
    }
  }
  return NextResponse.json({ ok: true });
}
