/**
 * Process-startup hook for the WeChat channel.
 *
 * The monitor is normally lazy-started by the /api/weixin/contacts endpoint
 * when the user opens the WeChat panel. That fails one important case:
 * pi-web boots up with an existing account.json on disk, and the user
 * never opens the panel — incoming WeChat messages would sit in the
 * upstream queue unconsumed.
 *
 * `bootstrap()` is invoked from instrumentation.ts so it runs once per
 * server-process boot. It also schedules a periodic re-check so a future
 * login from another tab/process is picked up without a server restart.
 *
 * When multiple pi-web processes run on the same machine (e.g. `next
 * start` on port 14514 + `next dev` on port 30141), only the lock holder
 * from `monitor-lock.ts` actually runs the monitor — the others stay
 * silent so the inbound poller is never duplicated.
 */
import { state, monitor, api } from "./index";
import { tryBecomeMonitorHost } from "./monitor-lock";
import { createLogger } from "@/lib/logger";

const log = createLogger("wechat/startup");

/** How often to re-check whether an account is configured (ms). */
const RESCAN_INTERVAL_MS = 30_000;

let rescanTimer: ReturnType<typeof setInterval> | null = null;
let bootstrapped = false;
let lastSeenAccountId: string | null = null;

export function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  if (!tryBecomeMonitorHost()) {
    log.debug("another process hosts the wechat monitor; this process stays silent");
    return;
  }

  // First-pass: if a previous run left an account on disk, kick the
  // monitor immediately. This is the bug-fix case — user has logged in
  // before, server restarts, monitor would otherwise sit idle.
  const account = state.loadAccount();
  if (account) {
    lastSeenAccountId = account.accountId;
    log.info("existing account detected, starting monitor", { accountId: account.accountId });
    // Re-announce "bot online" to iLink. notifyStart is normally fired
    // once on QR-login, but iLink treats a long-idle bot process as
    // offline and stops enqueuing incoming messages for it. Without
    // this, the first user message after a server restart is silently
    // dropped at the upstream before getUpdates can ever pull it.
    api.notifyStart({ baseUrl: account.baseUrl, token: account.token })
      .then(() => log.info("iLink notifyStart ok on boot", { accountId: account.accountId }))
      .catch((err) => log.warn("iLink notifyStart failed on boot (ignored)", { error: String(err) }));
    monitor.ensureMonitor();
  } else {
    log.debug("no account on disk, monitor stays idle");
  }

  // Periodic rescan: a user might log in from a different process (e.g.
  // a /api/weixin/login POST) without reloading this module. The monitor
  // itself has its own auto-stop when the account is cleared, so we only
  // need to worry about the boot-to-logged-in transition. The
  // `lastSeenAccountId` dedupe keeps the "account appeared" log line
  // from re-firing every rescan tick (the underlying `ensureMonitor`
  // is still cheap, but the log was drowning out every other channel).
  rescanTimer = setInterval(() => {
    const cur = state.loadAccount();
    if (cur && cur.accountId !== lastSeenAccountId) {
      lastSeenAccountId = cur.accountId;
      log.info("account appeared, starting monitor", { accountId: cur.accountId });
      monitor.ensureMonitor();
    } else if (!cur && lastSeenAccountId !== null) {
      lastSeenAccountId = null;
    }
    // No explicit "stop" branch — monitor.stopMonitor is called by
    // /api/weixin/logout, and the monitor's tick loop self-terminates
    // when loadAccount() returns null.
  }, RESCAN_INTERVAL_MS);
  // Don't keep the process alive just for the rescan timer.
  if (typeof rescanTimer.unref === "function") rescanTimer.unref();
}
