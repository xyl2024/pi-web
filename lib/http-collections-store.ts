/**
 * SQLite-backed CRUD for HTTP request Collections. See plan:
 * `effervescent-imagining-hummingbird.md`.
 *
 * Mirror of `lib/todo-store.ts`: validation, custom error classes,
 * row-to-type mappers, and `db.transaction(() => { ... })()` blocks for
 * mutating ops that touch more than one table.
 *
 * All reads go through the singleton DB handle in `lib/http-collections-db.ts`.
 * No in-memory cache; freshness is the React layer's job (see
 * `hooks/useHttpCollections.ts`).
 */

import { getHttpCollectionsDb } from "@/lib/http-collections-db";
import {
  type Collection,
  type CreateCollectionInput,
  type CreateItemInput,
  type HttpItem,
  type ListAllResponse,
  type UpdateCollectionInput,
  type UpdateItemInput,
  HttpCollectionNotFoundError,
  generateId,
  normalizeTags,
  validateBody,
  validateBodyMode,
  validateCollectionIds,
  validateDescription,
  validateKvRows,
  validateMethod,
  validateName,
  validateTimeoutMs,
  validateUrl,
} from "@/lib/http-collections-schema";
import type { KVRow } from "@/hooks/httpStore";

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface CollectionRow {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  name: string;
  description: string;
  method: string;
  url: string;
  params_json: string;
  headers_json: string;
  body_mode: string;
  body: string;
  timeout_ms: number | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

interface JoinRow {
  collection_id: string;
  item_id: string;
  position: number;
  created_at: number;
}

function parseKvRowsJson(raw: string): KVRow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: KVRow[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const v = parsed[i];
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      if (typeof o.key !== "string" || typeof o.value !== "string") continue;
      out.push({
        id: typeof o.id === "string" && o.id.length > 0 ? o.id : `kv-restored-${i}`,
        key: o.key,
        value: o.value,
        enabled: typeof o.enabled === "boolean" ? o.enabled : true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function parseTagsJson(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function rowToCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToItem(row: ItemRow): HttpItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    method: row.method as HttpItem["method"],
    url: row.url,
    params: parseKvRowsJson(row.params_json),
    headers: parseKvRowsJson(row.headers_json),
    bodyMode: row.body_mode as HttpItem["bodyMode"],
    body: row.body,
    timeoutMs: row.timeout_ms,
    tags: parseTagsJson(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Collection CRUD
// ---------------------------------------------------------------------------

export function createCollection(input: CreateCollectionInput): Collection {
  const name = validateName(input.name, "name");
  const description = validateDescription(input.description, "description");

  const id = generateId();
  const now = Date.now();
  const db = getHttpCollectionsDb();
  db.prepare(
    `INSERT INTO collections (id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, description, now, now);
  return { id, name, description, createdAt: now, updatedAt: now };
}

export function updateCollection(
  id: string,
  patch: UpdateCollectionInput,
): Collection {
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpCollectionNotFoundError("collection", String(id));
  }
  const db = getHttpCollectionsDb();
  const apply = db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM collections WHERE id = ?`)
      .get(id) as CollectionRow | undefined;
    if (!row) throw new HttpCollectionNotFoundError("collection", id);
    const next = rowToCollection(row);
    if (patch.name !== undefined) {
      next.name = validateName(patch.name, "name");
    }
    if (patch.description !== undefined) {
      next.description = validateDescription(patch.description, "description");
    }
    next.updatedAt = Date.now();
    db.prepare(
      `UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
    ).run(next.name, next.description, next.updatedAt, id);
    return next;
  });
  return apply();
}

export function deleteCollection(id: string): { id: string; unlinkedFrom: number } {
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpCollectionNotFoundError("collection", String(id));
  }
  const db = getHttpCollectionsDb();
  const apply = db.transaction(() => {
    // Count join rows first so the caller can show a progressive-deletion
    // warning ("{n} items will be unlinked") before the click.
    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM collection_items WHERE collection_id = ?`)
      .get(id) as { c: number };
    const result = db.prepare(`DELETE FROM collections WHERE id = ?`).run(id);
    if (result.changes === 0) throw new HttpCollectionNotFoundError("collection", id);
    return { id, unlinkedFrom: countRow.c };
  });
  return apply();
}

export function getCollectionById(id: string): Collection | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  const row = getHttpCollectionsDb()
    .prepare(`SELECT * FROM collections WHERE id = ?`)
    .get(id) as CollectionRow | undefined;
  return row ? rowToCollection(row) : undefined;
}

// ---------------------------------------------------------------------------
// Item CRUD
// ---------------------------------------------------------------------------

export function createItem(input: CreateItemInput): HttpItem {
  const name = validateName(input.name, "name");
  const description = validateDescription(input.description, "description");
  const method = validateMethod(input.method, "method");
  const url = validateUrl(input.url, "url");
  const bodyMode = validateBodyMode(input.bodyMode, "bodyMode");
  const body = validateBody(input.body, "body");
  const params = validateKvRows(input.params, "params");
  const headers = validateKvRows(input.headers, "headers");
  const timeoutMs = validateTimeoutMs(input.timeoutMs, "timeoutMs");
  const tags = normalizeTags(input.tags, "tags");
  const collectionIds = validateCollectionIds(input.collectionIds, "collectionIds");

  const id = generateId();
  const now = Date.now();
  const db = getHttpCollectionsDb();

  const apply = db.transaction(() => {
    // Pre-validate that every collection_id actually exists, so we don't
    // leave orphan join rows pointing at missing collections. The CASCADE
    // foreign key would also handle a missing collection (insert would fail
    // with a constraint error), but a clean error message is friendlier.
    const placeholders = collectionIds.map(() => "?").join(",");
    const found = db
      .prepare(
        `SELECT id FROM collections WHERE id IN (${placeholders})`,
      )
      .all(...collectionIds) as Array<{ id: string }>;
    if (found.length !== collectionIds.length) {
      const foundSet = new Set(found.map((r) => r.id));
      const missing = collectionIds.find((c) => !foundSet.has(c));
      throw new HttpCollectionNotFoundError("collection", String(missing));
    }

    db.prepare(
      `INSERT INTO items
         (id, name, description, method, url, params_json, headers_json,
          body_mode, body, timeout_ms, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      description,
      method,
      url,
      JSON.stringify(params),
      JSON.stringify(headers),
      bodyMode,
      body,
      timeoutMs,
      JSON.stringify(tags),
      now,
      now,
    );

    const join = db.prepare(
      `INSERT INTO collection_items (collection_id, item_id, position, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (let i = 0; i < collectionIds.length; i++) {
      join.run(collectionIds[i], id, i, now);
    }
  });
  apply();

  return {
    id,
    name,
    description,
    method,
    url,
    params,
    headers,
    bodyMode,
    body,
    timeoutMs,
    tags,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateItem(id: string, patch: UpdateItemInput): HttpItem {
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpCollectionNotFoundError("item", String(id));
  }
  const db = getHttpCollectionsDb();

  const apply = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as
      | ItemRow
      | undefined;
    if (!row) throw new HttpCollectionNotFoundError("item", id);
    const next = rowToItem(row);

    if (patch.name !== undefined) {
      next.name = validateName(patch.name, "name");
    }
    if (patch.description !== undefined) {
      next.description = validateDescription(patch.description, "description");
    }
    if (patch.method !== undefined) {
      next.method = validateMethod(patch.method, "method");
    }
    if (patch.url !== undefined) {
      next.url = validateUrl(patch.url, "url");
    }
    if (patch.bodyMode !== undefined) {
      next.bodyMode = validateBodyMode(patch.bodyMode, "bodyMode");
    }
    if (patch.body !== undefined) {
      next.body = validateBody(patch.body, "body");
    }
    if (patch.params !== undefined) {
      next.params = validateKvRows(patch.params, "params");
    }
    if (patch.headers !== undefined) {
      next.headers = validateKvRows(patch.headers, "headers");
    }
    if (patch.timeoutMs !== undefined) {
      next.timeoutMs = validateTimeoutMs(patch.timeoutMs, "timeoutMs");
    }
    if (patch.tags !== undefined) {
      next.tags = normalizeTags(patch.tags, "tags");
    }
    next.updatedAt = Date.now();

    db.prepare(
      `UPDATE items
         SET name = ?, description = ?, method = ?, url = ?,
             params_json = ?, headers_json = ?, body_mode = ?, body = ?,
             timeout_ms = ?, tags_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.description,
      next.method,
      next.url,
      JSON.stringify(next.params),
      JSON.stringify(next.headers),
      next.bodyMode,
      next.body,
      next.timeoutMs,
      JSON.stringify(next.tags),
      next.updatedAt,
      id,
    );

    if (patch.collectionIds !== undefined) {
      const collectionIds = validateCollectionIds(
        patch.collectionIds,
        "collectionIds",
      );
      // Same pre-check as createItem so the error message is friendly.
      const placeholders = collectionIds.map(() => "?").join(",");
      const found = db
        .prepare(
          `SELECT id FROM collections WHERE id IN (${placeholders})`,
        )
        .all(...collectionIds) as Array<{ id: string }>;
      if (found.length !== collectionIds.length) {
        const foundSet = new Set(found.map((r) => r.id));
        const missing = collectionIds.find((c) => !foundSet.has(c));
        throw new HttpCollectionNotFoundError("collection", String(missing));
      }
      db.prepare(`DELETE FROM collection_items WHERE item_id = ?`).run(id);
      const join = db.prepare(
        `INSERT INTO collection_items (collection_id, item_id, position, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (let i = 0; i < collectionIds.length; i++) {
        join.run(collectionIds[i], id, i, Date.now());
      }
    }

    return next;
  });
  return apply();
}

export function deleteItem(id: string): { id: string; unlinkedFrom: number } {
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpCollectionNotFoundError("item", String(id));
  }
  const db = getHttpCollectionsDb();
  const apply = db.transaction(() => {
    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM collection_items WHERE item_id = ?`)
      .get(id) as { c: number };
    const result = db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
    if (result.changes === 0) throw new HttpCollectionNotFoundError("item", id);
    return { id, unlinkedFrom: countRow.c };
  });
  return apply();
}

export function getItemById(id: string): HttpItem | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  const row = getHttpCollectionsDb()
    .prepare(`SELECT * FROM items WHERE id = ?`)
    .get(id) as ItemRow | undefined;
  return row ? rowToItem(row) : undefined;
}

// ---------------------------------------------------------------------------
// Full snapshot — single fetch per the Y1/Z1 plan
// ---------------------------------------------------------------------------

export function listAll(): ListAllResponse {
  const db = getHttpCollectionsDb();
  const collectionRows = db
    .prepare(`SELECT * FROM collections ORDER BY created_at ASC`)
    .all() as CollectionRow[];
  const itemRows = db
    .prepare(`SELECT * FROM items ORDER BY created_at ASC`)
    .all() as ItemRow[];
  const joinRows = db
    .prepare(
      `SELECT collection_id, item_id, position, created_at
         FROM collection_items
        ORDER BY created_at ASC`,
    )
    .all() as JoinRow[];

  return {
    collections: collectionRows.map(rowToCollection),
    items: itemRows.map(rowToItem),
    joinRows: joinRows.map((r) => ({
      collectionId: r.collection_id,
      itemId: r.item_id,
      position: r.position,
      createdAt: r.created_at,
    })),
  };
}
