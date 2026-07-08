/**
 * Public types, validation helpers, and error classes for the Inbox message
 * center. Storage lives in `lib/inbox-store.ts` on top of `lib/inbox-db.ts`.
 * This file is the contract between storage, HTTP routes, and the React layer.
 *
 * Mirror of `lib/http-collections-schema.ts`: pure data + validators, no IO.
 */

export type InboxLevel = "info" | "warn" | "error";

export const INBOX_LEVELS: readonly InboxLevel[] = ["info", "warn", "error"] as const;

export interface InboxMessage {
  id: string;
  ts: number;
  source: string;
  level: InboxLevel;
  title: string;
  payload?: Record<string, unknown>;
}

export interface InboxListResponse {
  messages: InboxMessage[];
}

export interface InboxPushInput {
  source: string;
  level?: InboxLevel;
  title: string;
  payload?: Record<string, unknown>;
}

export class InboxValidationError extends Error {
  public readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "InboxValidationError";
    this.field = field;
  }
}

export const MAX_SOURCE_LENGTH = 64;
export const MAX_TITLE_LENGTH = 300;
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export function validateSource(raw: unknown, field: string = "source"): string {
  if (typeof raw !== "string") {
    throw new InboxValidationError(field, `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InboxValidationError(field, `${field} cannot be empty`);
  }
  if (trimmed.length > MAX_SOURCE_LENGTH) {
    throw new InboxValidationError(field, `${field} is too long`);
  }
  return trimmed;
}

export function validateLevel(raw: unknown, field: string = "level"): InboxLevel {
  if (raw === undefined || raw === null) return "info";
  if (typeof raw !== "string") {
    throw new InboxValidationError(field, `${field} must be a string`);
  }
  const lower = raw.toLowerCase();
  if (!INBOX_LEVELS.includes(lower as InboxLevel)) {
    throw new InboxValidationError(
      field,
      `${field} must be one of: ${INBOX_LEVELS.join(", ")}`,
    );
  }
  return lower as InboxLevel;
}

export function validateTitle(raw: unknown, field: string = "title"): string {
  if (typeof raw !== "string") {
    throw new InboxValidationError(field, `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InboxValidationError(field, `${field} cannot be empty`);
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new InboxValidationError(field, `${field} is too long`);
  }
  return trimmed;
}

export function validatePayload(
  raw: unknown,
  field: string = "payload",
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InboxValidationError(field, `${field} must be an object`);
  }
  return raw as Record<string, unknown>;
}

export function generateInboxId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}