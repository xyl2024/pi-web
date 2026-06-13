/**
 * Process-startup hook for the scheduled-tasks scheduler.
 *
 * Mirrors `lib/wechat/startup.ts`: called from `instrumentation.ts` so the
 * loop boots as soon as the server is ready, regardless of whether any
 * page has been requested. Idempotent — safe to call multiple times.
 */

import { ensureLoop } from "./loop";
import { createLogger } from "@/lib/logger";

const log = createLogger("scheduler/startup");

let bootstrapped = false;

export function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  log.info("scheduler bootstrap");
  ensureLoop();
}