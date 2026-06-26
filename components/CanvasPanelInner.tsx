"use client";

// Canvas panel — single global Excalidraw whiteboard, persisted in
// browser localStorage. Wired into the right-panel as the "画布" /
// "Canvas" tab.

import { useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useToast } from "@/components/Toast";

// Namespaced localStorage key + schema version (K3+V2).
const STORAGE_KEY = "pi-web:canvas:v1";
const STORAGE_VERSION = 1;
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
  const { t } = useI18n();
  const { isDark } = useTheme();
  const toast = useToast();

  // Loaded synchronously on first render — client-only module via dynamic,
  // so window/localStorage is always available here.
  const [initialData] = useState<ExcalidrawInitialDataState | null>(() => loadCanvasState());

  // Hold latest elements/appState in refs so flush listeners (which run
  // outside React's render cycle, e.g. inside `beforeunload`) always read
  // the freshest values.
  const pendingRef = useRef<{
    elements: ExcalidrawInitialDataState["elements"];
    appState: ExcalidrawInitialDataState["appState"];
  } | null>(null);
  const hasUserEditedRef = useRef(false);
  const saveFailureShownRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushNow = useRef<() => void>(() => {});
  flushNow.current = () => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    const ok = saveCanvasState(pending.elements, pending.appState);
    if (!ok && !saveFailureShownRef.current) {
      saveFailureShownRef.current = true;
      toast.show({
        kind: "error",
        message: t("Canvas save failed — localStorage may be full"),
      });
    }
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
  ) => {
    hasUserEditedRef.current = true;
    pendingRef.current = { elements, appState };
    if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      flushNow.current();
    }, DEBOUNCE_MS);
  };

  const theme = isDark ? "dark" as const : "light" as const;

  // useMemo keeps the props object stable across renders — important so
  // Excalidraw doesn't re-initialize every render.
  const excalidrawProps = useMemo(
    () => ({
      initialData: initialData ?? undefined,
      onChange: handleChange,
      theme,
    }),
    [initialData, theme],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minHeight: 0 }}>
      <Excalidraw {...excalidrawProps} />
    </div>
  );
}