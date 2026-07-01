/**
 * Public types, validation helpers, and error classes for the HTTP request
 * Collections feature. The data is stored in `lib/http-collections-store.ts`
 * using the schema in `lib/http-collections-db.ts`; this file is the contract
 * between storage and the HTTP routes / React layer.
 *
 * Type-only imports from `hooks/httpStore` (a "use client" module) are safe
 * because they are erased at compile time and never reach the client bundle.
 */

import type { HttpMethod, BodyMode, KVRow } from "@/hooks/httpStore";

export interface Collection {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface HttpItem {
  id: string;
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  params: KVRow[];
  headers: KVRow[];
  bodyMode: BodyMode;
  body: string;
  timeoutMs: number | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CollectionItemJoinRow {
  collectionId: string;
  itemId: string;
  position: number;
  createdAt: number;
}

export interface ListAllResponse {
  collections: Collection[];
  items: HttpItem[];
  joinRows: CollectionItemJoinRow[];
}

export interface CreateCollectionInput {
  name: string;
  description?: string;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string;
}

export interface CreateItemInput {
  name: string;
  description?: string;
  method: HttpMethod;
  url: string;
  params: KVRow[];
  headers: KVRow[];
  bodyMode: BodyMode;
  body: string;
  timeoutMs?: number | null;
  tags?: string[];
  /** At least one collection must be selected. */
  collectionIds: string[];
}

export interface UpdateItemInput {
  name?: string;
  description?: string;
  method?: HttpMethod;
  url?: string;
  params?: KVRow[];
  headers?: KVRow[];
  bodyMode?: BodyMode;
  body?: string;
  timeoutMs?: number | null;
  tags?: string[];
  /** When present, the full membership set is replaced atomically. */
  collectionIds?: string[];
}

export class HttpCollectionValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "HttpCollectionValidationError";
  }
}

export class HttpCollectionNotFoundError extends Error {
  public readonly id: string;
  constructor(kind: "collection" | "item", id: string) {
    super(`${kind} not found`);
    this.name = "HttpCollectionNotFoundError";
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// Constants — duplicated from components/HttpPanel.tsx HTTP_METHODS so the
// server-side validator doesn't depend on a "use client" runtime export.
// Keep in sync if the list ever grows.
// ---------------------------------------------------------------------------

export const HTTP_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_TAG_LENGTH = 50;
export const MAX_URL_LENGTH = 8_192; // 8 KB
export const MAX_BODY_LENGTH = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateName(value: unknown, field: string = "name"): string {
  if (typeof value !== "string") {
    throw new HttpCollectionValidationError(`${field} must be a string`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpCollectionValidationError(`${field} cannot be empty`, field);
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new HttpCollectionValidationError(`${field} is too long`, field);
  }
  return trimmed;
}

export function validateDescription(
  value: unknown,
  field: string = "description",
): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new HttpCollectionValidationError(`${field} must be a string`, field);
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new HttpCollectionValidationError(`${field} is too long`, field);
  }
  return value;
}

export function validateMethod(value: unknown, field: string = "method"): HttpMethod {
  if (typeof value !== "string") {
    throw new HttpCollectionValidationError(`${field} must be a string`, field);
  }
  const upper = value.toUpperCase();
  if (!HTTP_METHODS.includes(upper as HttpMethod)) {
    throw new HttpCollectionValidationError(
      `${field} must be one of: ${HTTP_METHODS.join(", ")}`,
      field,
    );
  }
  return upper as HttpMethod;
}

export function validateUrl(value: unknown, field: string = "url"): string {
  if (typeof value !== "string") {
    throw new HttpCollectionValidationError(`${field} must be a string`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpCollectionValidationError(`${field} cannot be empty`, field);
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new HttpCollectionValidationError(`${field} is too long`, field);
  }
  return trimmed;
}

export function validateBodyMode(value: unknown, field: string = "bodyMode"): BodyMode {
  if (value !== "none" && value !== "json" && value !== "raw") {
    throw new HttpCollectionValidationError(
      `${field} must be one of: none, json, raw`,
      field,
    );
  }
  return value;
}

export function validateBody(value: unknown, field: string = "body"): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new HttpCollectionValidationError(`${field} must be a string`, field);
  }
  if (value.length > MAX_BODY_LENGTH) {
    throw new HttpCollectionValidationError(`${field} is too long`, field);
  }
  return value;
}

export function validateTimeoutMs(value: unknown, field: string = "timeoutMs"): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpCollectionValidationError(
      `${field} must be a positive number or null`,
      field,
    );
  }
  return Math.floor(value);
}

/**
 * Normalize a tag list: trim each entry, drop empties, dedupe case-insensitively
 * (preserving the first occurrence's casing). Used at every write site so the
 * stored array is always canonical.
 */
export function normalizeTags(value: unknown, field: string = "tags"): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpCollectionValidationError(`${field} must be an array`, field);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new HttpCollectionValidationError(
        `${field} entries must be strings`,
        field,
      );
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new HttpCollectionValidationError(`${field} entry is too long`, field);
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function validateKvRows(value: unknown, field: string): KVRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpCollectionValidationError(`${field} must be an array`, field);
  }
  const out: KVRow[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (!raw || typeof raw !== "object") {
      throw new HttpCollectionValidationError(
        `${field}[${i}] must be an object`,
        field,
      );
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.value !== "string") {
      throw new HttpCollectionValidationError(
        `${field}[${i}].key and value must be strings`,
        field,
      );
    }
    if (typeof o.enabled !== "boolean") {
      throw new HttpCollectionValidationError(
        `${field}[${i}].enabled must be a boolean`,
        field,
      );
    }
    out.push({
      // Trust any string id from the client; the server doesn't care about it.
      id: typeof o.id === "string" && o.id.length > 0 ? o.id : `kv-restored-${i}`,
      key: o.key,
      value: o.value,
      enabled: o.enabled,
    });
  }
  return out;
}

export function validateCollectionIds(
  value: unknown,
  field: string = "collectionIds",
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpCollectionValidationError(
      `${field} must be a non-empty array of ids`,
      field,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "string" || v.length === 0) {
      throw new HttpCollectionValidationError(
        `${field}[${i}] must be a non-empty string`,
        field,
      );
    }
    out.push(v);
  }
  // Dedupe (a user could double-click submit before the state cleared)
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
