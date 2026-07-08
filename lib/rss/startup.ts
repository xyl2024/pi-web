/**
 * Process-startup hook for the RSS refresh loop.
 *
 * Mirrors `lib/scheduler/startup.ts` and `lib/wechat/startup.ts`: called from
 * `instrumentation.ts` so the loop boots as soon as the server is ready,
 * regardless of whether any page has been requested. Idempotent — safe to
 * call multiple times (which can happen across HMR reloads in dev mode).
 */

import { ensureLoop } from "./loop";
import { ensureDigestLoop } from "./digest";
import { createLogger } from "@/lib/logger";

const log = createLogger("rss/startup");

let bootstrapped = false;

export function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  log.info("rss bootstrap");
  ensureLoop();
  ensureDigestLoop();
}