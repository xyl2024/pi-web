/**
 * sessions.log — append-only JSONL trail of every inbound WeChat message
 * and the full lifecycle that follows (cold-start / send / typing / agent_end
 * / reply). One line per event. Designed for O2-style troubleshooting:
 * given a userId + time window, you can reconstruct everything that
 * happened in chronological order.
 *
 * File: ~/.pi-web/wechat/sessions.log (chmod 600 best-effort)
 */
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type SessionLogEvent =
  | { kind: "inbound"; fromUserId: string; text: string; contextToken?: string }
  | { kind: "command"; fromUserId: string; command: string }
  | { kind: "cold_start"; sessionId: string; cwd: string; fromUserId: string }
  | { kind: "send"; sessionId: string; fromUserId: string; text: string }
  | { kind: "typing"; sessionId: string; fromUserId: string }
  | { kind: "agent_event"; sessionId: string; eventType: string; fromUserId: string }
  | { kind: "agent_end"; sessionId: string; fromUserId: string; durationMs: number; replyText: string }
  | { kind: "agent_error"; sessionId: string; fromUserId: string; error: string }
  | { kind: "reply"; sessionId: string; fromUserId: string; length: number; messageId?: number }
  | { kind: "reply_failed"; sessionId: string; fromUserId: string; error: string };

function logPath(): string {
  return join(homedir(), ".pi-web", "wechat", "sessions.log");
}

let initialized = false;
function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  const p = logPath();
  if (!existsSync(p)) {
    try {
      mkdirSync(join(homedir(), ".pi-web", "wechat"), { recursive: true });
      writeFileSync(p, "", "utf8");
    } catch {
      // best-effort
    }
  }
}

export function logSessionEvent(event: SessionLogEvent): void {
  ensureInit();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try {
    appendFileSync(logPath(), line + "\n", "utf8");
  } catch {
    // best-effort, never block the main flow
  }
}
