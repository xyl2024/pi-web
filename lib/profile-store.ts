import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createLogger } from "./logger";

const log = createLogger("profile-store");

export const PROFILE_DIR = join(homedir(), ".pi-web", "profile");
const USER_FILE = join(PROFILE_DIR, "user.json");
const AVATAR_FILE = join(PROFILE_DIR, "avatar.png");

export interface UserProfile {
  username: string | null;
}

const MAX_USERNAME_LENGTH = 64;

function ensureDir(): void {
  mkdirSync(PROFILE_DIR, { recursive: true });
}

function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    throw new Error(`username too long (max ${MAX_USERNAME_LENGTH} chars)`);
  }
  return trimmed;
}

/**
 * Read the user profile from ~/.pi-web/profile/user.json.
 * Returns { username: null } when the file is missing or malformed.
 */
export function readProfile(): UserProfile {
  try {
    if (!existsSync(USER_FILE)) return { username: null };
    const raw = readFileSync(USER_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { username: null };
    const obj = parsed as Record<string, unknown>;
    return { username: normalizeUsername(obj.username) };
  } catch (err) {
    log.warn("failed to read profile, returning empty", { error: String(err) });
    return { username: null };
  }
}

/**
 * Write the user profile to ~/.pi-web/profile/user.json.
 * Returns the normalized profile.
 */
export function writeProfile(profile: UserProfile): UserProfile {
  ensureDir();
  const username = normalizeUsername(profile.username);
  writeFileSync(USER_FILE, JSON.stringify({ username }, null, 2), "utf8");
  log.info("profile written", { username });
  return { username };
}

export function getAvatarPath(): string {
  return resolve(AVATAR_FILE);
}

export function avatarExists(): boolean {
  return existsSync(AVATAR_FILE);
}

export function writeAvatar(buffer: Buffer): void {
  ensureDir();
  writeFileSync(AVATAR_FILE, buffer);
  log.info("avatar written", { bytes: buffer.length });
}

export function removeAvatar(): void {
  if (!existsSync(AVATAR_FILE)) return;
  unlinkSync(AVATAR_FILE);
  log.info("avatar removed");
}

export { MAX_USERNAME_LENGTH };