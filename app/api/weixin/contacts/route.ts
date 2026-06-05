/**
 * GET /api/weixin/contacts
 *   response: { contacts: WeChatContact[], monitorRunning: boolean }
 *
 *   Returns the in-memory contact list for the current account. Auto-starts
 *   the background poller if a logged-in account is detected.
 *
 * DELETE /api/weixin/contacts
 *   response: { ok: true }
 *
 *   Clears the in-memory contact list. Does NOT stop the monitor.
 */
import { NextResponse } from "next/server";
import { state, monitor } from "@/lib/wechat";

export const dynamic = "force-dynamic";

export async function GET() {
  const account = state.loadAccount();
  if (!account) {
    return NextResponse.json({ contacts: [], monitorRunning: false, configured: false });
  }
  monitor.ensureMonitor();
  const contacts = state.listContacts(account.accountId);
  return NextResponse.json({
    contacts,
    monitorRunning: monitor.isMonitorRunning(),
    configured: true,
  });
}

export async function DELETE() {
  const account = state.loadAccount();
  if (account) {
    state.clearContacts(account.accountId);
  }
  return NextResponse.json({ ok: true });
}
