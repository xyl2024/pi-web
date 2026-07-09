/**
 * Single-instance lock for the WeChat inbound monitor.
 *
 * Why this exists: pi-web may be started more than once on the same
 * machine — e.g. `next start` on port 14514 and `next dev` on port
 * 30141 both run from this checkout. Without a lock, each process
 * boots its own copy of the monitor + its own 30-second rescan timer,
 * so the inbound poller is duplicated and the rescan logs drown out
 * every other log channel.
 *
 * The lock is a small JSON file at ~/.pi-web/wechat-monitor.lock. The
 * holder writes its PID + a renewedAt timestamp every 30 seconds.
 * Newcomers read the file and ask (a) is the holder's PID alive, (b)
 * is the renewedAt fresh. If either check fails, the lock is stale
 * and we steal it. The steal path uses `openSync(path, "wx")` —
 * atomic O_EXCL create — so it never overwrites an active lock
 * belonging to another holder. (We do call `unlinkSync` first when
 * stealing a known-stale lock; that path is the only place a pre-
 * existing user-data file is removed, and the file is one we wrote
 * ourselves, not user content.)
 *
 * What this does NOT do: it does not lock the rest of pi-web, only
 * the wechat monitor + its rescan timer.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { createLogger } from "@/lib/logger";

const log = createLogger("wechat/monitor-lock");

const LOCK_PATH = join(homedir(), ".pi-web", "wechat-monitor.lock");
const STALE_RENEW_MS = 90_000;
const RENEW_INTERVAL_MS = 30_000;

type LockRecord = {
  pid: number;
  startedAt: number;
  renewedAt: number;
};

let held = false;
let exiting = false;
let startedAt = 0;
let renewTimer: ReturnType<typeof setInterval> | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(): LockRecord | null {
  try {
    const text = readFileSync(LOCK_PATH, "utf8");
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "number" ||
      typeof parsed.renewedAt !== "number"
    ) {
      return null;
    }
    return parsed as LockRecord;
  } catch {
    return null;
  }
}

function writeFreshLock(fd: number, record: LockRecord): void {
  const json = `${JSON.stringify(record)}\n`;
  writeSync(fd, json);
  closeSync(fd);
}

function claimLock(): boolean {
  const record: LockRecord = {
    pid: process.pid,
    startedAt: Date.now(),
    renewedAt: Date.now(),
  };

  try {
    const fd = openSync(LOCK_PATH, "wx", 0o600);
    writeFreshLock(fd, record);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const existing = readLock();
  if (!existing) return false;
  if (existing.pid === process.pid) return true;
  if (pidAlive(existing.pid) && Date.now() - existing.renewedAt < STALE_RENEW_MS) {
    return false;
  }

  try {
    unlinkSync(LOCK_PATH);
  } catch {
    const after = readLock();
    if (after && pidAlive(after.pid) && Date.now() - after.renewedAt < STALE_RENEW_MS) {
      return false;
    }
    try { unlinkSync(LOCK_PATH); } catch { /* fall through */ }
  }

  try {
    const fd = openSync(LOCK_PATH, "wx", 0o600);
    writeFreshLock(fd, record);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function installExitHooks(): void {
  const release = () => {
    if (!held || exiting) return;
    exiting = true;
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    if (!existsSync(LOCK_PATH)) return;
    try {
      const cur = readLock();
      if (cur && cur.pid === process.pid) unlinkSync(LOCK_PATH);
    } catch (err) {
      log.warn("failed to remove lock file on exit", { error: String(err) });
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      release();
      const code = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129;
      process.exit(code);
    });
  }
}

export function isMonitorHost(): boolean {
  return held;
}

export function tryBecomeMonitorHost(): boolean {
  if (held) return true;
  if (exiting) return false;

  mkdirSync(dirname(LOCK_PATH), { recursive: true });

  let claimed = false;
  try {
    claimed = claimLock();
  } catch (err) {
    log.warn("failed to claim wechat monitor lock", { error: String(err) });
    return false;
  }
  if (!claimed) {
    log.debug("another process holds the wechat monitor lock");
    return false;
  }

  held = true;
  startedAt = Date.now();
  installExitHooks();
  renewTimer = setInterval(() => {
    if (!held) return;
    try {
      const fd = openSync(LOCK_PATH, "w", 0o600);
      writeFreshLock(fd, { pid: process.pid, startedAt, renewedAt: Date.now() });
    } catch (err) {
      log.warn("failed to renew wechat monitor lock", { error: String(err) });
    }
  }, RENEW_INTERVAL_MS);
  if (typeof renewTimer.unref === "function") renewTimer.unref();
  log.info("acquired wechat monitor lock", { pid: process.pid });
  return true;
}