/**
 * IndexedDB-backed storage for Excalidraw image files (paste / drop payloads).
 *
 * Excalidraw's `onChange(elements, appState, files)` emits `files` keyed by
 * `fileId`; only the `fileId` is embedded in image elements (with
 * `status: "pending"`). The actual dataURL lives here so it survives reload.
 *
 * Mirrors `lib/db.ts`'s boundary: only this module knows about the storage
 * backend. Singleton store cached on `globalThis` so Next.js dev-mode HMR
 * doesn't re-open the database on every code change.
 *
 * Browser-only. Callers must be behind `dynamic({ ssr: false })` or
 * otherwise guarantee `indexedDB` is defined (see `components/CanvasPanel.tsx`).
 *
 * # Garbage collection
 *
 * Mirrors `excalidraw-app/data/LocalData.ts` `LocalFileManager.clearObsoleteFiles`:
 * an orphan file (no element references it) is reaped once it has been
 * untouched for 24h. "Touched" means a read that updated `lastRetrieved`,
 * so frequently-used files stay alive while delete-and-leave-it images
 * eventually free their quota.
 *
 * The sweep is opt-in — `deleteOrphanFiles(referencedIds)` — and is
 * triggered from the canvas panel on initial mount.
 */

import {
  createStore,
  del,
  entries,
  getMany,
  keys,
  setMany,
} from "idb-keyval";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

const DB_NAME = "pi-web-canvas";
const STORE_NAME = "files-store";

// Official Excalidraw uses 24h. Recent deletes remain recoverable via undo
// for that window; beyond it the user is unlikely to come back, and the
// quota reclaim is worth more than the long-tail recovery case.
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

type FilesStore = ReturnType<typeof createStore>;

declare global {
  var __piCanvasFilesStore: FilesStore | undefined;
}

function getStore(): FilesStore {
  if (globalThis.__piCanvasFilesStore) return globalThis.__piCanvasFilesStore;
  globalThis.__piCanvasFilesStore = createStore(DB_NAME, STORE_NAME);
  return globalThis.__piCanvasFilesStore;
}

export type BinaryFiles = Record<string, BinaryFileData>;

/**
 * Read every persisted file into a `BinaryFiles` map. For each file whose
 * `id` is in `referencedIds`, also update its `lastRetrieved` to now.
 *
 * The selective touch is intentional: only files the canvas actually
 * needs are refreshed. If we touched everything, orphans would never
 * age out — every reload would push their `lastRetrieved` forward.
 *
 * Returns `{}` if IndexedDB is unavailable, the store is empty, or the
 * read failed. Errors are logged and surface as an empty result — the
 * same "degrade gracefully" policy as `lib/payload-capture.ts`.
 */
export async function loadAndTouchFiles(
  referencedIds: ReadonlySet<string>,
): Promise<BinaryFiles> {
  if (typeof indexedDB === "undefined") return {};
  const store = getStore();
  try {
    const allKeys = (await keys(store)) as string[];
    if (allKeys.length === 0) return {};
    const values = (await getMany(allKeys, store)) as (
      | BinaryFileData
      | undefined
    )[];
    const out: BinaryFiles = {};
    const toTouch: [string, BinaryFileData][] = [];
    const now = Date.now();
    for (let i = 0; i < allKeys.length; i++) {
      const v = values[i];
      if (v && typeof v === "object" && typeof v.id === "string") {
        out[allKeys[i]] = v;
        // Only refresh the freshness stamp on files still in use; let
        // orphans age out so the GC sweep can reap them.
        if (referencedIds.has(allKeys[i]) && v.lastRetrieved !== now) {
          toTouch.push([allKeys[i], { ...v, lastRetrieved: now }]);
        }
      }
    }
    if (toTouch.length > 0) {
      try {
        await setMany(toTouch, store);
      } catch (err) {
        // Touch failure is non-fatal — the load itself succeeded, and
        // the next reload will retry the touch.
        console.warn("[canvas-files] lastRetrieved touch failed", err);
      }
    }
    return out;
  } catch (err) {
    console.error("[canvas-files] loadAndTouchFiles failed", err);
    return {};
  }
}

/**
 * Persist a batch of files. Returns the list of fileIds actually written
 * so the caller can mark them as "saved" — important so a failed write
 * leaves the next debounce tick free to retry the same dataURL.
 *
 * Newly-saved files intentionally have no `lastRetrieved`: that field
 * is the "last time this file was used" stamp, set on read, and a fresh
 * save hasn't been read yet. The GC sweep will reap such a file on
 * the next load if no element references it — which is the right
 * behavior for "paste then immediately delete" patterns.
 *
 * Rejects on failure; callers decide how to surface that (toast, retry).
 */
export async function saveFiles(files: BinaryFiles): Promise<string[]> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB unavailable");
  }
  const ids = Object.keys(files);
  if (ids.length === 0) return [];
  const store = getStore();
  await setMany(
    ids.map((id) => [id, files[id]] as [string, BinaryFileData]),
    store,
  );
  return ids;
}

/**
 * Sweep orphaned files: any file NOT in `referencedIds` and either never
 * touched (`!lastRetrieved`) or untouched for `STALE_THRESHOLD_MS` is
 * deleted. Returns the deleted fileIds (mostly useful for logging/tests).
 *
 * Mirrors `LocalData.clearObsoleteFiles` in the official Excalidraw app:
 * a file that's still on the canvas is always safe, regardless of age.
 *
 * Errors are logged and swallowed — GC is best-effort. A failed sweep
 * just leaks the same files until the next attempt; the next reload
 * will retry. The canvas remains fully functional either way.
 */
export async function deleteOrphanFiles(
  referencedIds: ReadonlySet<string>,
): Promise<string[]> {
  if (typeof indexedDB === "undefined") return [];
  const store = getStore();
  try {
    const all = (await entries(store)) as [string, BinaryFileData][];
    if (all.length === 0) return [];
    const now = Date.now();
    const toDelete: string[] = [];
    for (const [id, data] of all) {
      if (referencedIds.has(id)) continue;
      const lastRetrieved = data?.lastRetrieved;
      if (!lastRetrieved || now - lastRetrieved > STALE_THRESHOLD_MS) {
        toDelete.push(id);
      }
    }
    if (toDelete.length === 0) return [];
    await Promise.all(toDelete.map((id) => del(id, store)));
    return toDelete;
  } catch (err) {
    console.error("[canvas-files] deleteOrphanFiles failed", err);
    return [];
  }
}
