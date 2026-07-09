"use client";

// Canvas panel — single global Excalidraw whiteboard. Elements and
// appState are persisted in browser localStorage; pasted/dropped image
// dataURLs are persisted in IndexedDB (see `lib/canvas-files-store.ts`).
// The split mirrors the official Excalidraw app: localStorage has the
// small/textual state, IDB holds the bulky binary blobs.

import { useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type {
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useToast } from "@/components/Toast";
import {
  deleteOrphanFiles,
  loadAndTouchFiles,
  saveFiles,
  type BinaryFiles,
} from "@/lib/canvas-files-store";

// Namespaced localStorage key + schema version. Bumped to v2 in tandem with
// the IndexedDB image storage change — v1 image elements stored `fileId`
// references without ever persisting the dataURL, so those images are
// unrecoverable on reload. New keys cleanly orphan the v1 entry.
const STORAGE_KEY = "pi-web:canvas:v2";
const STORAGE_VERSION = 2;
const DEBOUNCE_MS = 300;

// Fields that either break JSON serialization (Map, browser API) or are
// purely transient UI state. Source: packages/excalidraw/appState.ts
// `APP_STATE_STORAGE_CONF` entries with `browser: false`, plus a few
// well-known transient UI fields (`editingTextElement`, etc.).
const TRANSIENT_APP_STATE_KEYS = new Set<string>([
  "collaborators",
  "fileHandle",
  "newElement",
  "editingTextElement",
  "editingFrame",
  "editingLinearElement",
  "selectionElement",
  "snapLines",
  "contextMenu",
  "openMenu",
  "openPopup",
  "openDialog",
  "openSidebar",
  "isResizing",
  "isRotating",
  "isCropping",
  "isLoading",
  "croppingElementId",
  "activeEmbeddable",
  "activeLockedId",
  "lastPointerDownWith",
  "errorMessage",
  "hoveredElementIds",
  "elementsToHighlight",
  "frameToHighlight",
  "multiElement",
  "cursorButton",
  "penDetected",
  "previousSelectedElementIds",
]);

function cleanAppState(appState: unknown): Record<string, unknown> | null {
  if (!appState || typeof appState !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(appState as Record<string, unknown>)) {
    if (TRANSIENT_APP_STATE_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// Minimal shape we accept on load — keeps corruption isolated to fields we
// actually need to restore.
type PersistedCanvas = {
  version: number;
  elements: ExcalidrawInitialDataState["elements"];
  appState: ExcalidrawInitialDataState["appState"];
  savedAt: number;
};

/**
 * Collect fileIds from non-deleted image elements. Drives the IndexedDB
 * GC sweep: a file is "in use" iff at least one non-deleted image
 * element points at it. Deleted image elements don't keep their blobs
 * alive — once a delete has stood for 24h, the blob is reaped.
 *
 * Matches the official Excalidraw app's effective behavior, where
 * `localStorage` only stores `getNonDeletedElements(elements)` and the
 * `fileIds` passed to `clearObsoleteFiles` therefore excludes deleted
 * image fileIds by construction.
 */
function collectReferencedFileIds(
  elements: ExcalidrawInitialDataState["elements"],
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(elements)) return ids;
  for (const el of elements) {
    if (!el || typeof el !== "object") continue;
    const e = el as { type?: unknown; isDeleted?: unknown; fileId?: unknown };
    if (e.type !== "image") continue;
    if (e.isDeleted === true) continue;
    if (typeof e.fileId !== "string" || e.fileId.length === 0) continue;
    ids.add(e.fileId);
  }
  return ids;
}

function loadCanvasState(): ExcalidrawInitialDataState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedCanvas;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== STORAGE_VERSION) {
      // Schema mismatch — discard; future migrations would hook in here.
      return null;
    }
    if (!Array.isArray(parsed.elements)) return null;
    return {
      elements: parsed.elements,
      appState: parsed.appState ?? null,
    };
  } catch (err) {
    // Corrupted JSON or disabled storage — treat as empty (L1).
    console.warn("[canvas] failed to load persisted state:", err);
    return null;
  }
}

function saveCanvasState(
  elements: ExcalidrawInitialDataState["elements"],
  appState: ExcalidrawInitialDataState["appState"],
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const cleaned = cleanAppState(appState);
    const payload: PersistedCanvas = {
      version: STORAGE_VERSION,
      elements,
      appState: cleaned as ExcalidrawInitialDataState["appState"],
      savedAt: Date.now(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    // QuotaExceededError or disabled storage — caller decides whether to
    // surface this to the user (E3: first failure only).
    return false;
  }
}

export function CanvasPanelInner() {
  const { t, locale } = useI18n();
  const { isDark } = useTheme();
  const toast = useToast();

  // `initialData` is the function form (`() => MaybePromise<...>` per
  // ExcalidrawProps). Excalidraw awaits it on mount, so our IDB load races
  // safely with first paint — no useState/useEffect plumbing required, no
  // window where Excalidraw is mounted with an empty `files` map.
  const [initialData] = useState<ExcalidrawProps["initialData"]>(() => async () => {
    const local = loadCanvasState();
    // The set of fileIds we just loaded from localStorage is the same
    // set the canvas is about to render — exactly what `loadAndTouchFiles`
    // needs to refresh and what `deleteOrphanFiles` needs to protect.
    const referenced = collectReferencedFileIds(local?.elements);
    const files = await loadAndTouchFiles(referenced);
    // Fire-and-forget GC: a failed sweep is logged inside the store and
    // never blocks the canvas. Mirrors official Excalidraw's
    // `clearObsoleteFiles` placement after the initial scene resolves.
    void deleteOrphanFiles(referenced);
    return {
      elements: local?.elements ?? [],
      appState: local?.appState ?? null,
      files,
    };
  });

  // Hold latest elements/appState/files in refs so flush listeners (which
  // run outside React's render cycle, e.g. inside `beforeunload`) always
  // read the freshest values.
  const pendingRef = useRef<{
    elements: ExcalidrawInitialDataState["elements"];
    appState: ExcalidrawInitialDataState["appState"];
    files: BinaryFiles;
  } | null>(null);
  // fileIds we've successfully written to IDB in this session — used to
  // avoid re-writing the same dataURL on every keystroke.
  const savedFileIdsRef = useRef<Set<string>>(new Set());
  const hasUserEditedRef = useRef(false);
  const saveFailureShownRef = useRef(false);
  const idbFailureShownRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushNow = useRef<() => void>(() => {});
  flushNow.current = () => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;

    // 1. localStorage — sync, fast, small payload.
    const ok = saveCanvasState(pending.elements, pending.appState);
    if (!ok && !saveFailureShownRef.current) {
      saveFailureShownRef.current = true;
      toast.show({
        kind: "error",
        message: t("Canvas save failed — localStorage may be full"),
      });
    }

    // 2. IndexedDB — async, holds the bulky image dataURLs. Only write
    //    fileIds we haven't already persisted in this session.
    const toWrite: BinaryFiles = {};
    for (const [id, file] of Object.entries(pending.files)) {
      if (!savedFileIdsRef.current.has(id)) toWrite[id] = file;
    }
    if (Object.keys(toWrite).length === 0) return;

    saveFiles(toWrite).then(
      (writtenIds) => {
        for (const id of writtenIds) savedFileIdsRef.current.add(id);
      },
      (err) => {
        // Don't update savedFileIdsRef on failure — next flush will retry.
        console.error("[canvas-panel] IDB save failed", err);
        if (!idbFailureShownRef.current) {
          idbFailureShownRef.current = true;
          toast.show({
            kind: "error",
            message: t(
              "Canvas image save failed — recent images may not reload",
            ),
          });
        }
      },
    );
  };

  // Flush before tab close / browser navigation / page hide.
  useEffect(() => {
    const handler = () => flushNow.current();
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
    };
  }, []);

  // Flush when tab is hidden — covers alt-tab away mid-debounce.
  useEffect(() => {
    const handler = () => {
      if (document.hidden) flushNow.current();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  // Final flush on unmount.
  useEffect(() => {
    return () => {
      flushNow.current();
    };
  }, []);

  const handleChange = (
    elements: ExcalidrawInitialDataState["elements"],
    appState: ExcalidrawInitialDataState["appState"],
    files: BinaryFiles,
  ) => {
    hasUserEditedRef.current = true;
    pendingRef.current = { elements, appState, files };
    if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      flushNow.current();
    }, DEBOUNCE_MS);
  };

  const theme = isDark ? "dark" as const : "light" as const;

  // Map pi-web's "en" | "zh" locale to Excalidraw's BCP-47 language code.
  // Excalidraw internally calls `setLanguage(langCode)` inside
  // `InitializeApp` on every change (see packages/excalidraw/components/
  // InitializeApp.tsx), which dynamically imports the matching
  // `./locales/<code>.json` and re-renders translated strings. The canvas
  // content (elements + appState) is persisted in pi-web's own localStorage
  // and survives the brief remount during a language switch.
  const langCode = locale === "zh" ? "zh-CN" : "en";

  // useMemo keeps the props object stable across renders — important so
  // Excalidraw doesn't re-initialize every render. `langCode` is listed so
  // a locale toggle propagates through.
  const excalidrawProps = useMemo(
    () => ({
      initialData: initialData ?? undefined,
      onChange: handleChange,
      theme,
      langCode,
    }),
    [initialData, theme, langCode],
  );

  return (
    <div
      data-pi-canvas-panel="true"
      style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}
    >
      <Excalidraw {...excalidrawProps} />
    </div>
  );
}