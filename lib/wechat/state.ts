/**
 * Persistent account storage + in-memory login session map + contact list.
 *
 * Credentials:    ~/.pi-web/wechat/account.json (chmod 600)
 * Login sessions: in-memory Map, lost on restart (intentional — user re-scans).
 * Contacts:       in-memory Map keyed by accountId → userId → WeChatContact.
 *                 Lost on restart (intentional — fresh slate after server bounce).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { createLogger } from "@/lib/logger";
import type { LoginSession, WeChatAccount, WeChatContact } from "./types";

const log = createLogger("wechat/state");

function wechatDir(): string {
  return join(homedir(), ".pi-web", "wechat");
}

function accountPath(): string {
  return join(wechatDir(), "account.json");
}

// ---------------------------------------------------------------------------
// Account credentials
// ---------------------------------------------------------------------------

export function loadAccount(): WeChatAccount | null {
  const p = accountPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as WeChatAccount;
    if (parsed && typeof parsed.token === "string" && parsed.token.length > 0) {
      return parsed;
    }
  } catch (err) {
    log.warn("failed to read account", { error: String(err) });
  }
  return null;
}

export function saveAccount(account: WeChatAccount): void {
  const dir = wechatDir();
  mkdirSync(dir, { recursive: true });
  const p = accountPath();
  writeFileSync(p, JSON.stringify(account, null, 2), "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort
  }
  log.info("account saved", { accountId: account.accountId });
}

export function clearAccount(): void {
  const p = accountPath();
  try {
    if (existsSync(p)) unlinkSync(p);
    log.info("account cleared");
  } catch (err) {
    log.warn("failed to clear account", { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// In-memory login sessions
// ---------------------------------------------------------------------------

const sessions = new Map<string, LoginSession>();
const SESSION_TTL_MS = 6 * 60 * 1000;

function purgeExpired(): void {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.startedAt > SESSION_TTL_MS) sessions.delete(k);
  }
}

export function createSession(initial: Omit<LoginSession, "sessionKey" | "startedAt" | "phase">): LoginSession {
  purgeExpired();
  const session: LoginSession = {
    ...initial,
    sessionKey: randomUUID(),
    startedAt: Date.now(),
    phase: "waiting",
  };
  sessions.set(session.sessionKey, session);
  return session;
}

export function getSession(sessionKey: string): LoginSession | null {
  const s = sessions.get(sessionKey);
  if (!s) return null;
  if (Date.now() - s.startedAt > SESSION_TTL_MS) {
    sessions.delete(sessionKey);
    return null;
  }
  return s;
}

export function updateSession(sessionKey: string, patch: Partial<LoginSession>): LoginSession | null {
  const s = getSession(sessionKey);
  if (!s) return null;
  const merged = { ...s, ...patch };
  sessions.set(sessionKey, merged);
  return merged;
}

export function dropSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// In-memory contact list (per accountId)
// ---------------------------------------------------------------------------

const contacts = new Map<string, Map<string, WeChatContact>>();

function getContactsBucket(accountId: string): Map<string, WeChatContact> {
  let bucket = contacts.get(accountId);
  if (!bucket) {
    bucket = new Map();
    contacts.set(accountId, bucket);
  }
  return bucket;
}

/** List all known contacts for an account, most recently seen first. */
export function listContacts(accountId: string): WeChatContact[] {
  const bucket = contacts.get(accountId);
  if (!bucket) return [];
  return Array.from(bucket.values()).sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

/**
 * Record (or update) a contact based on an inbound message. Called from
 * the monitor loop. Updates `lastSeen` / `messageCount` / preview and
 * refreshes the cached context token.
 */
export function recordContact(
  accountId: string,
  userId: string,
  preview: string,
  contextToken?: string,
): WeChatContact {
  const bucket = getContactsBucket(accountId);
  const now = new Date().toISOString();
  const existing = bucket.get(userId);
  const next: WeChatContact = {
    userId,
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
    messageCount: (existing?.messageCount ?? 0) + 1,
    lastMessagePreview: preview.slice(0, 80),
    contextToken: contextToken ?? existing?.contextToken,
  };
  bucket.set(userId, next);
  log.debug("contact recorded", { accountId, userId, messageCount: next.messageCount });
  return next;
}

/** Clear all contacts for an account (called on logout). */
export function clearContacts(accountId: string): void {
  contacts.delete(accountId);
}
