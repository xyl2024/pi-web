/**
 * Background poller for inbound WeChat messages.
 *
 * Strategy: 3-second short-poll loop (not true long-poll) — simpler to reason
 * about, no long-lived HTTP connections, fine for a demo.
 *
 * Lifecycle: refcount-free singleton. Started lazily by the contacts API
 * when a logged-in account is detected. Stops automatically when the
 * account is cleared (logout).
 *
 * Behavior per tick:
 *   1. Load account from disk. None → stop.
 *   2. POST getupdates with current sync_buf and 3s timeout.
 *   3. For each msg: extract sender + first text preview + context_token,
 *      record into the contact map.
 *   4. Persist the new sync_buf (in memory only).
 *   5. Schedule next tick.
 */
import { api, state } from "@/lib/wechat";
import type { WeixinMessage } from "@/lib/wechat";
import { handleInbound } from "@/lib/wechat/inbound";
import { createLogger } from "@/lib/logger";

const log = createLogger("wechat/monitor");

/** How long each upstream getUpdates request holds. Short for a demo. */
const POLL_TIMEOUT_MS = 3_000;
/** Idle gap between ticks. */
const POLL_INTERVAL_MS = 1_000;

const syncBufs = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

export function isMonitorRunning(): boolean {
  return timer !== null;
}

/** Start the poller. No-op if already running. */
export function startMonitor(): void {
  if (timer !== null) return;
  log.info("monitor starting");
  scheduleNext(0);
}

/** Stop the poller. Safe to call when not running. */
export function stopMonitor(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
    log.info("monitor stopped");
  }
}

/** Auto-start if logged in, no-op otherwise. Called from the contacts API. */
export function ensureMonitor(): void {
  if (timer !== null) return;
  const account = state.loadAccount();
  if (!account) return;
  startMonitor();
}

function scheduleNext(delayMs: number): void {
  if (timer !== null) return;
  timer = setTimeout(tick, delayMs);
}

async function tick(): Promise<void> {
  timer = null;
  if (inFlight) {
    // Re-arm and try again next interval.
    scheduleNext(POLL_INTERVAL_MS);
    return;
  }
  inFlight = true;
  try {
    const account = state.loadAccount();
    if (!account) {
      // Account was cleared (logout) — shut down.
      syncBufs.delete(accountStateId());
      return;
    }

    const cursorKey = account.accountId;
    const prevBuf = syncBufs.get(cursorKey) ?? "";
    const resp = await api.getUpdates({
      baseUrl: account.baseUrl,
      token: account.token,
      getUpdatesBuf: prevBuf,
      timeoutMs: POLL_TIMEOUT_MS,
    });

    if (resp.ret !== undefined && resp.ret !== 0) {
      log.warn("getUpdates non-zero ret", { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg });
    }

    if (resp.get_updates_buf) {
      syncBufs.set(cursorKey, resp.get_updates_buf);
    }

    const msgs = resp.msgs ?? [];
    for (const msg of msgs) {
      const userId = msg.from_user_id;
      if (!userId) continue;
      const preview = extractPreview(msg);
      state.recordContact(account.accountId, userId, preview, msg.context_token);
      // Fire-and-forget inbound handler for text messages. Non-text
      // (image/voice/file) is recorded as a contact only — no reply path
      // exists yet. The handler is fully self-contained: it picks the
      // current session (or cold-starts), runs the agent, and sends the
      // reply back to WeChat. Errors are reported to the user by the
      // handler itself, so we don't need to await or surface anything
      // back into the poller.
      if (preview) {
        void handleInbound({
          fromUserId: userId,
          text: preview,
          contextToken: msg.context_token,
        });
      }
    }

    if (msgs.length > 0) {
      log.info("monitor received messages", { count: msgs.length, accountId: account.accountId });
    }
  } catch (err) {
    log.warn("monitor tick failed", { error: String(err) });
  } finally {
    inFlight = false;
    // Keep polling.
    scheduleNext(POLL_INTERVAL_MS);
  }
}

function accountStateId(): string {
  return state.loadAccount()?.accountId ?? "";
}

/** Pull the first short text snippet from a Weixin message item list. */
function extractPreview(msg: WeixinMessage): string {
  const items = msg.item_list ?? [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) {
      return String(item.text_item.text);
    }
  }
  return "";
}
