"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import { Tooltip } from "./Tooltip";
import {
  useHttpState,
  setHttpMethod,
  setHttpUrl,
  setHttpHeaders,
  setHttpBodyMode,
  setHttpBody,
  setHttpTimeoutMs,
  addKvRow,
  removeKvRow,
  updateKvRow,
  setHttpInFlight,
  setHttpLastResponse,
  setHttpError,
  setHttpLastAttempt,
  clearHttpPanel,
  loadHttpDraftFromItem,
  kvRowsToObject,
  buildFinalUrl,
  deriveContentType,
  newKvId,
  type HttpMethod,
  type BodyMode,
  type KVRow,
  type HttpDraft,
  type HttpResponse,
  type HttpError,
} from "@/hooks/httpStore";
import { useHttpCollections } from "@/hooks/useHttpCollections";
import { HttpPanelCollections } from "./HttpPanelCollections";
import {
  HttpPanelSaveItemModal,
  type SaveItemModalInitialValues,
} from "./HttpPanelSaveItemModal";
import { HttpPanelEditCollectionModal } from "./HttpPanelEditCollectionModal";
import type {
  Collection,
  HttpItem,
} from "@/lib/http-collections-schema";
import { parseCurl } from "@/lib/curl-parser";
import { parseJsonTolerant, minifyJson } from "@/lib/json-parser";
import { copyText } from "./CodeBlock";
import {
  JsonTreeView,
  collectAllContainerPaths,
  collectContainerPathsAtDepth,
  pathKey as jsonPathKey,
  type JsonPath,
  type JsonValue,
} from "./JsonTreeView";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const DIVIDER_STORAGE_KEY = "pi-http-divider-height";
const DEFAULT_DIVIDER_HEIGHT = 240;
const DRAWER_OPEN_STORAGE_KEY = "pi-http-collections-drawer-open";
const DRAWER_WIDTH = 240;

/** Last path segment of a URL, or the full URL if no path. Used as the
 *  default name when saving the current draft to a collection. */
function defaultItemNameFromUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "";
  // Strip query string / hash before reading the path
  const qIdx = trimmed.indexOf("?");
  const hIdx = trimmed.indexOf("#");
  const cut = [qIdx, hIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  const withoutQ = cut >= 0 ? trimmed.slice(0, cut) : trimmed;
  // Drop origin if present
  const slashIdx = withoutQ.indexOf("//");
  const afterScheme = slashIdx >= 0 ? withoutQ.slice(slashIdx + 2) : withoutQ;
  const pathStart = afterScheme.indexOf("/");
  const pathOnly = pathStart >= 0 ? afterScheme.slice(pathStart + 1) : "";
  const lastSlash = pathOnly.lastIndexOf("/");
  const lastSeg = lastSlash >= 0 ? pathOnly.slice(lastSlash + 1) : pathOnly;
  return lastSeg.length > 0 ? lastSeg : trimmed;
}

export function HttpPanel() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useHttpState();

  const clientControllerRef = useRef<AbortController | null>(null);
  const [dividerHeight, setDividerHeight] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_DIVIDER_HEIGHT;
    const stored = window.localStorage.getItem(DIVIDER_STORAGE_KEY);
    const n = stored ? parseInt(stored, 10) : NaN;
    return Number.isFinite(n) && n >= 80 && n <= 1200 ? n : DEFAULT_DIVIDER_HEIGHT;
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Collections drawer + save / replace modal state
  const collectionsApi = useHttpCollections();
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(DRAWER_OPEN_STORAGE_KEY);
    if (stored === null) return true; // W3: default expanded on first use
    return stored === "1";
  });
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<HttpItem | null>(null);
  const [editingItemCollectionIds, setEditingItemCollectionIds] = useState<
    string[] | null
  >(null);
  const [editingCollection, setEditingCollection] = useState<Collection | null>(
    null,
  );
  const [replaceModalOpen, setReplaceModalOpen] = useState(false);
  const [replaceItem, setReplaceItem] = useState<HttpItem | null>(null);
  // If set, the save modal flow will also load this item on success
  // (the "Save & replace" 3-way path).
  const [pendingLoadAfterSave, setPendingLoadAfterSave] = useState<
    HttpItem | null
  >(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DRAWER_OPEN_STORAGE_KEY,
        drawerOpen ? "1" : "0",
      );
    } catch {
      /* localStorage unavailable */
    }
  }, [drawerOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DIVIDER_STORAGE_KEY, String(dividerHeight));
    } catch {
      /* localStorage unavailable */
    }
  }, [dividerHeight]);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = { startY: e.clientY, startHeight: dividerHeight };
    const onMove = (ev: MouseEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;
      // Dragging up increases height (response grows), dragging down shrinks.
      const delta = drag.startY - ev.clientY;
      const next = Math.max(80, Math.min(1200, drag.startHeight + delta));
      setDividerHeight(next);
    };
    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [dividerHeight]);

  const handleClear = useCallback(async () => {
    if (state.inFlight) {
      toast.show({ kind: "error", message: t("Cannot clear while a request is in flight") });
      return;
    }
    const ok = await confirm({
      title: t("Clear HTTP panel?"),
      description: t("This will reset the request form and clear the response. Headers and params you've added will be lost."),
      confirmLabel: t("Clear"),
      destructive: true,
    });
    if (!ok) return;
    clearHttpPanel();
  }, [state.inFlight, confirm, toast, t]);

  const handleSend = useCallback(async () => {
    if (state.inFlight) return;
    const draft = state.draft;
    if (!draft.url.trim()) {
      toast.show({ kind: "error", message: t("URL is required") });
      return;
    }

    if (draft.bodyMode === "json" && draft.body.trim()) {
      try {
        JSON.parse(draft.body);
      } catch (e) {
        toast.show({
          kind: "error",
          message: t("Invalid JSON: {error}").replace("{error}", e instanceof Error ? e.message : String(e)),
        });
        return;
      }
    }

    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    clientControllerRef.current = controller;

    setHttpError(null);
    setHttpInFlight({ id, startedAt: Date.now() });
    setHttpLastAttempt(draft);

    const finalUrl = buildFinalUrl(draft);
    const headers = kvRowsToObject(draft.headers);
    const fetchBody = draft.bodyMode === "none" ? undefined : draft.body;

    try {
      const res = await fetch("/api/http", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          method: draft.method,
          url: finalUrl,
          headers,
          body: fetchBody,
          bodyEncoding: "text",
          timeoutMs: draft.options.timeoutMs,
          sizeLimitBytes: 10 * 1024 * 1024,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as
        | (HttpResponse & { ok: true; id: string })
        | { ok: false; id: string; error: HttpError["kind"]; message: string; durationMs: number };
      if (data.ok) {
        const response: HttpResponse = {
          status: data.status,
          statusText: data.statusText,
          headers: data.headers,
          body: data.body,
          bodyEncoding: data.bodyEncoding,
          durationMs: data.durationMs,
          size: data.size,
          contentType: deriveContentType(data.headers),
        };
        setHttpLastResponse(response);
      } else {
        setHttpError({ kind: data.error, message: data.message });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setHttpError({ kind: "aborted", message: t("Request cancelled") });
      } else {
        setHttpError({
          kind: "network",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      setHttpInFlight(null);
      clientControllerRef.current = null;
    }
  }, [state.inFlight, state.draft, toast, t]);

  const handleCancel = useCallback(() => {
    clientControllerRef.current?.abort();
    if (state.inFlight) {
      fetch(`/api/http/${encodeURIComponent(state.inFlight.id)}/cancel`, { method: "POST" }).catch(() => {});
    }
  }, [state.inFlight]);

  const handleQuickAddBearer = useCallback(() => {
    const existing = state.draft.headers.find((r) => r.enabled && r.key.toLowerCase() === "authorization");
    if (existing) {
      updateKvRow("headers", existing.id, { value: "Bearer " });
      return;
    }
    const row: KVRow = { id: `kv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, key: "Authorization", value: "Bearer ", enabled: true };
    setHttpHeaders([...state.draft.headers, row]);
  }, [state.draft.headers]);

  const handleQuickAddContentType = useCallback(() => {
    const existing = state.draft.headers.find((r) => r.enabled && r.key.toLowerCase() === "content-type");
    if (existing) {
      updateKvRow("headers", existing.id, { value: "application/json" });
      return;
    }
    const row: KVRow = { id: `kv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, key: "Content-Type", value: "application/json", enabled: true };
    setHttpHeaders([...state.draft.headers, row]);
  }, [state.draft.headers]);

  // ── Import cURL modal state ──────────────────────────────────────────
  const [importCurlOpen, setImportCurlOpen] = useState(false);
  const [importCurlText, setImportCurlText] = useState("");
  const [importCurlError, setImportCurlError] = useState<string | null>(null);

  const handleImportClick = useCallback(() => {
    setImportCurlText("");
    setImportCurlError(null);
    setImportCurlOpen(true);
  }, []);

  const handleImportClose = useCallback(() => {
    setImportCurlOpen(false);
    setImportCurlText("");
    setImportCurlError(null);
  }, []);

  const handleImportConfirm = useCallback(async () => {
    const result = parseCurl(importCurlText);
    if (!result.ok) {
      setImportCurlError(
        t("Could not parse cURL command: {message}").replace("{message}", result.message),
      );
      return;
    }
    const draft = state.draft;
    const dirty =
      draft.url.trim() !== "" ||
      draft.params.length > 0 ||
      draft.headers.length > 0 ||
      draft.body.trim() !== "";
    if (dirty) {
      const ok = await confirm({
        title: t("Replace the current request?"),
        description: t("This will overwrite the current request form (method, URL, headers, body)."),
        confirmLabel: t("Replace"),
        destructive: true,
      });
      if (!ok) return;
    }
    const parsed = result.parsed;
    const headers: KVRow[] = parsed.headers.map((h) => ({
      id: newKvId(),
      key: h.key,
      value: h.value,
      enabled: true,
    }));
    setHttpMethod(parsed.method);
    setHttpUrl(parsed.url);
    setHttpHeaders(headers);
    setHttpBodyMode(parsed.bodyMode);
    setHttpBody(parsed.body);
    setHttpLastResponse(null);
    setHttpError(null);
    setImportCurlOpen(false);
    setImportCurlText("");
    setImportCurlError(null);
    if (parsed.skipped.length > 0) {
      toast.show({
        kind: "info",
        message: t("Skipped unsupported flags: {list}").replace("{list}", parsed.skipped.join(", ")),
      });
    }
  }, [importCurlText, state.draft, confirm, toast, t]);

  // ── Collections handlers ──────────────────────────────────────────────

  const buildItemCollectionIds = useCallback(
    (itemId: string): string[] => {
      return collectionsApi.joinRows
        .filter((j) => j.itemId === itemId)
        .map((j) => j.collectionId);
    },
    [collectionsApi.joinRows],
  );

  const handleSaveClick = useCallback(() => {
    if (state.inFlight) {
      toast.show({ kind: "error", message: t("Cannot clear while a request is in flight") });
      return;
    }
    if (!state.draft.url.trim()) {
      toast.show({ kind: "error", message: t("URL is required") });
      return;
    }
    setEditingItem(null);
    setEditingItemCollectionIds(null);
    setPendingLoadAfterSave(null);
    setSaveModalOpen(true);
  }, [state.inFlight, state.draft, toast, t]);

  const handleSaveSubmit = useCallback(
    async (input: import("@/lib/http-collections-schema").CreateItemInput): Promise<HttpItem> => {
      const item = await collectionsApi.createItem(input);
      toast.show({ kind: "success", message: t("Item saved") });
      return item;
    },
    [collectionsApi, toast, t],
  );

  const handleUpdateSubmit = useCallback(
    async (id: string, patch: import("@/lib/http-collections-schema").UpdateItemInput): Promise<HttpItem> => {
      const item = await collectionsApi.updateItem(id, patch);
      toast.show({ kind: "success", message: t("Item updated") });
      return item;
    },
    [collectionsApi, toast, t],
  );

  const handleCreateCollectionInModal = useCallback(
    async (input: { name: string; description?: string }): Promise<Collection> => {
      const c = await collectionsApi.createCollection(input);
      toast.show({ kind: "success", message: t("Collection created") });
      return c;
    },
    [collectionsApi, toast, t],
  );

  const doLoadItem = useCallback(
    (item: HttpItem) => {
      loadHttpDraftFromItem({
        method: item.method,
        url: item.url,
        params: item.params,
        headers: item.headers,
        bodyMode: item.bodyMode,
        body: item.body,
        timeoutMs: item.timeoutMs,
      });
      toast.show({
        kind: "success",
        message: t("Loaded {name}").replace("{name}", item.name),
      });
      setDrawerOpen(false);
    },
    [toast, t],
  );

  const handleLoadItem = useCallback(
    (item: HttpItem) => {
      if (state.isDirty) {
        // Open the 3-way modal
        setReplaceItem(item);
        setReplaceModalOpen(true);
        return;
      }
      doLoadItem(item);
    },
    [state.isDirty, doLoadItem],
  );

  const handleReplace = useCallback(() => {
    const item = replaceItem;
    setReplaceModalOpen(false);
    setReplaceItem(null);
    if (item) doLoadItem(item);
  }, [replaceItem, doLoadItem]);

  const handleSaveAndReplace = useCallback(() => {
    const item = replaceItem;
    setReplaceModalOpen(false);
    setReplaceItem(null);
    if (!item) return;
    if (state.inFlight) {
      toast.show({ kind: "error", message: t("Cannot clear while a request is in flight") });
      return;
    }
    if (!state.draft.url.trim()) {
      toast.show({ kind: "error", message: t("URL is required") });
      return;
    }
    setPendingLoadAfterSave(item);
    setEditingItem(null);
    setEditingItemCollectionIds(null);
    setSaveModalOpen(true);
  }, [replaceItem, state.inFlight, state.draft, toast, t]);

  const handleSaveModalClose = useCallback(() => {
    setSaveModalOpen(false);
    setEditingItem(null);
    setEditingItemCollectionIds(null);
    // Don't clear pendingLoadAfterSave yet — the onSubmit handler reads it
    // and clears it after the load completes (or the user cancels).
  }, []);

  const handleEditItem = useCallback(
    (item: HttpItem) => {
      setEditingItem(item);
      setEditingItemCollectionIds(buildItemCollectionIds(item.id));
      setPendingLoadAfterSave(null);
      setSaveModalOpen(true);
    },
    [buildItemCollectionIds],
  );

  const handleDeleteItem = useCallback(
    async (item: HttpItem) => {
      const unlinked = buildItemCollectionIds(item.id).length;
      const others = Math.max(0, unlinked - 1); // the "currently focused" collection is hidden
      const description =
        others === 0
          ? t("Delete this item?")
          : t("This will unlink the item from {n} other collection.").replace(
              "{n}",
              String(others),
            );
      const ok = await confirm({
        title: t("Delete item?"),
        description,
        confirmLabel: t("Delete"),
        destructive: true,
      });
      if (!ok) return;
      try {
        await collectionsApi.deleteItem(item.id);
        toast.show({ kind: "success", message: t("Item deleted") });
      } catch (e) {
        toast.show({
          kind: "error",
          message: e instanceof Error ? e.message : t("Failed to delete item"),
        });
      }
    },
    [buildItemCollectionIds, collectionsApi, confirm, toast, t],
  );

  const handleCreateCollectionInDrawer = useCallback(
    async (name: string): Promise<Collection | null> => {
      try {
        const c = await collectionsApi.createCollection({ name });
        toast.show({ kind: "success", message: t("Collection created") });
        return c;
      } catch (e) {
        toast.show({
          kind: "error",
          message: e instanceof Error ? e.message : t("Failed to save collection"),
        });
        return null;
      }
    },
    [collectionsApi, toast, t],
  );

  const handleEditCollection = useCallback(
    (collection: Collection) => {
      setEditingCollection(collection);
    },
    [],
  );

  const handleDeleteCollection = useCallback(
    async (collection: Collection, itemCount: number) => {
      const description = t(
        "Delete this collection? {n} items will be unlinked from this collection but remain in others.",
      ).replace("{n}", String(itemCount));
      const ok = await confirm({
        title: t("Delete collection?"),
        description,
        confirmLabel: t("Delete"),
        destructive: true,
      });
      if (!ok) return;
      try {
        const result = await collectionsApi.deleteCollection(collection.id);
        toast.show({ kind: "success", message: t("Collection deleted") });
        // result.unlinkedFrom intentionally not surfaced — the description
        // already previewed the count, and the user has acknowledged it.
        void result;
      } catch (e) {
        toast.show({
          kind: "error",
          message: e instanceof Error ? e.message : t("Failed to delete collection"),
        });
      }
    },
    [collectionsApi, confirm, toast, t],
  );

  // When the save modal completes successfully, if a load is pending, do it.
  // The `_item` arg is the just-created/updated item — we don't need it
  // here (we already have pendingLoadAfterSave) but the parent wires it
  // through for type symmetry.
  const handleSaveItemResolved = useCallback(
    async (item: HttpItem) => {
      void item;
      const pending = pendingLoadAfterSave;
      setPendingLoadAfterSave(null);
      if (pending) {
        doLoadItem(pending);
        // Override the "Item saved" toast with a combined message
        toast.show({
          kind: "success",
          message: t("Saved and loaded {name}").replace("{name}", pending.name),
        });
      }
      // Close the modal now that the create/edit succeeded.
      setSaveModalOpen(false);
      setEditingItem(null);
      setEditingItemCollectionIds(null);
    },
    [pendingLoadAfterSave, doLoadItem, toast, t],
  );

  const inFlight = !!state.inFlight;

  const saveModalInitialValues: SaveItemModalInitialValues | undefined = saveModalOpen
    ? {
        name: defaultItemNameFromUrl(state.draft.url),
        description: "",
        method: state.draft.method,
        url: state.draft.url,
        params: state.draft.params,
        headers: state.draft.headers,
        bodyMode: state.draft.bodyMode,
        body: state.draft.body,
        timeoutMs: state.draft.options.timeoutMs,
        tags: [],
      }
    : undefined;

  return (
    <div
      ref={containerRef}
      style={{ display: "flex", flexDirection: "row", height: "100%", background: "var(--bg)", overflow: "hidden" }}
    >
      <div
        style={{
          width: drawerOpen ? DRAWER_WIDTH : 0,
          overflow: "hidden",
          transition: "width 0.18s ease",
          flexShrink: 0,
        }}
        aria-hidden={!drawerOpen}
      >
        {drawerOpen && (
          <HttpPanelCollections
            collections={collectionsApi.collections}
            items={collectionsApi.items}
            joinRows={collectionsApi.joinRows}
            onLoadItem={handleLoadItem}
            onEditItem={handleEditItem}
            onDeleteItem={handleDeleteItem}
            onCreateCollection={handleCreateCollectionInDrawer}
            onEditCollection={handleEditCollection}
            onDeleteCollection={handleDeleteCollection}
          />
        )}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
          height: "100%",
          overflow: "hidden",
        }}
      >
        <PanelHeader
          onClear={handleClear}
          onImport={handleImportClick}
          onSave={handleSaveClick}
          drawerOpen={drawerOpen}
          onDrawerToggle={() => setDrawerOpen((v) => !v)}
        />
        <RequestLine
          draft={state.draft}
          inFlight={inFlight}
          onMethodChange={setHttpMethod}
          onUrlChange={setHttpUrl}
          onSend={handleSend}
          onCancel={handleCancel}
        />
        <RequestTabs
          draft={state.draft}
          onBodyModeChange={setHttpBodyMode}
          onBodyChange={setHttpBody}
          onAddKv={addKvRow}
          onRemoveKv={removeKvRow}
          onUpdateKv={updateKvRow}
          onQuickAddBearer={handleQuickAddBearer}
          onQuickAddContentType={handleQuickAddContentType}
          onTimeoutChange={setHttpTimeoutMs}
        />
        <DragDivider onMouseDown={handleDividerMouseDown} />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <ResponseSection
            response={state.lastResponse}
            error={state.error}
            inFlight={state.inFlight}
            onResend={handleSend}
          />
        </div>
        {importCurlOpen && (
          <ImportCurlModal
            value={importCurlText}
            error={importCurlError}
            onChange={setImportCurlText}
            onClose={handleImportClose}
            onConfirm={handleImportConfirm}
          />
        )}
      </div>
      {saveModalOpen && (
        <HttpPanelSaveItemModal
          mode={editingItem ? "edit" : "create"}
          initialValues={editingItem ? undefined : saveModalInitialValues}
          item={editingItem ?? undefined}
          itemCollectionIds={editingItemCollectionIds ?? undefined}
          collections={collectionsApi.collections}
          onCreate={async (input) => {
            const item = await handleSaveSubmit(input);
            await handleSaveItemResolved(item);
            return item;
          }}
          onUpdate={async (id, patch) => {
            const item = await handleUpdateSubmit(id, patch);
            await handleSaveItemResolved(item);
            return item;
          }}
          onCreateCollection={handleCreateCollectionInModal}
          onClose={handleSaveModalClose}
        />
      )}
      {editingCollection && (
        <HttpPanelEditCollectionModal
          collection={editingCollection}
          onUpdate={async (id, patch) => {
            try {
              await collectionsApi.updateCollection(id, patch);
              toast.show({ kind: "success", message: t("Collection updated") });
            } catch (e) {
              toast.show({
                kind: "error",
                message:
                  e instanceof Error
                    ? e.message
                    : t("Failed to update collection"),
              });
              throw e;
            }
          }}
          onClose={() => setEditingCollection(null)}
        />
      )}
      {replaceModalOpen && replaceItem && (
        <ReplaceDraftModal
          itemName={replaceItem.name}
          onReplace={handleReplace}
          onSaveAndReplace={handleSaveAndReplace}
          onCancel={() => {
            setReplaceModalOpen(false);
            setReplaceItem(null);
          }}
        />
      )}
    </div>
  );
}

// ── Import cURL modal ─────────────────────────────────────────────────────

function ImportCurlModal({
  value,
  error,
  onChange,
  onClose,
  onConfirm,
}: {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  // Esc closes the modal (no warning — a typed cURL is cheap to retype).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 600,
          maxWidth: "100%",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("Import cURL")}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("Paste a cURL command to populate the request form.")}
        </div>
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={"curl -X POST 'https://api.example.com/users' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"name\":\"alice\"}'"}
          style={{
            width: "100%",
            minHeight: 200,
            maxHeight: 360,
            padding: "9px 10px",
            background: "var(--bg)",
            border: error ? "1px solid #ef4444" : "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
        {error && (
          <div
            style={{
              fontSize: 11,
              color: "#ef4444",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("Cancel")}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "6px 14px",
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              borderRadius: 4,
              color: "var(--bg)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {t("Import cURL")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Replace draft modal (3-way: Replace / Save & replace / Cancel) ───────
// useConfirm only supports 2 buttons, so this is a bespoke modal that
// mirrors ImportCurlModal's visual style. Default focus is on the middle
// option (Save & replace) to make it the safest default if the user
// hammers Enter.

function ReplaceDraftModal({
  itemName,
  onReplace,
  onSaveAndReplace,
  onCancel,
}: {
  itemName: string;
  onReplace: () => void;
  onSaveAndReplace: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10001,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          minWidth: 360,
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--text)" }}>
          {t("Replace the current request?")}
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("Your draft has unsent changes. They will be lost.")}
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            borderTop: "1px solid var(--border)",
            paddingTop: 10,
            marginTop: 4,
          }}
        >
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            onClick={onReplace}
            style={{
              background: "transparent",
              border: "1px solid #ef4444",
              color: "#ef4444",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Replace")}
          </button>
          <button
            type="button"
            onClick={onSaveAndReplace}
            autoFocus
            style={{
              background: "var(--accent)",
              color: "var(--bg)",
              border: "none",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Save & replace")}
          </button>
        </div>
        <div
          aria-hidden
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            textAlign: "right",
          }}
        >
          {itemName}
        </div>
      </div>
    </div>
  );
}

// ── Panel header ──────────────────────────────────────────────────────────

function PanelHeader({
  onClear,
  onImport,
  onSave,
  drawerOpen,
  onDrawerToggle,
}: {
  onClear: () => void;
  onImport: () => void;
  onSave: () => void;
  drawerOpen: boolean;
  onDrawerToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 32,
        padding: "0 8px 0 4px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <Tooltip content={drawerOpen ? t("Hide collections") : t("Show collections")}>
          <button
            onClick={onDrawerToggle}
            aria-label={drawerOpen ? t("Hide collections") : t("Show collections")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: drawerOpen ? "var(--bg-hover)" : "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: drawerOpen ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = drawerOpen
                ? "var(--accent)"
                : "var(--text-muted)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
            </svg>
          </button>
        </Tooltip>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginLeft: 4 }}>{t("HTTP")}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Tooltip content={t("Save")}>
          <button
            onClick={onSave}
            aria-label={t("Save")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip content={t("Import cURL")}>
          <button
            onClick={onImport}
            aria-label={t("Import cURL")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip content={t("Clear request and response")}>
          <button
            onClick={onClear}
            aria-label={t("Clear")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#ef4444";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// ── Request line: method + URL + Send ─────────────────────────────────────

function RequestLine({
  draft,
  inFlight,
  onMethodChange,
  onUrlChange,
  onSend,
  onCancel,
}: {
  draft: HttpDraft;
  inFlight: boolean;
  onMethodChange: (m: HttpMethod) => void;
  onUrlChange: (url: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const methodColor =
    draft.method === "GET" ? "var(--accent)" :
    draft.method === "POST" ? "#16a34a" :
    draft.method === "DELETE" ? "#ef4444" :
    draft.method === "PUT" || draft.method === "PATCH" ? "#f59e0b" :
    "var(--text-muted)";

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!inFlight) onSend();
    }
  }, [inFlight, onSend]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 6,
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <select
        value={draft.method}
        onChange={(e) => onMethodChange(e.target.value as HttpMethod)}
        disabled={inFlight}
        style={{
          height: 32,
          padding: "0 8px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: methodColor,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          fontWeight: 600,
          cursor: inFlight ? "default" : "pointer",
          outline: "none",
        }}
      >
        {HTTP_METHODS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <input
        type="text"
        value={draft.url}
        onChange={(e) => onUrlChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="https://api.example.com/path"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        style={{
          flex: 1,
          height: 32,
          padding: "0 10px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          outline: "none",
        }}
      />
      {inFlight ? (
        <button
          onClick={onCancel}
          style={{
            height: 32,
            padding: "0 14px",
            background: "#ef4444",
            border: "1px solid #ef4444",
            borderRadius: 6,
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("Cancel")}
        </button>
      ) : (
        <button
          onClick={onSend}
          style={{
            height: 32,
            padding: "0 14px",
            background: "var(--accent)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            color: "var(--bg)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {t("Send")}
        </button>
      )}
    </div>
  );
}

// ── Sub-tabs (Params / Headers / Body) ─────────────────────────────────────

type SubTab = "params" | "headers" | "body";

function RequestTabs({
  draft,
  onBodyModeChange,
  onBodyChange,
  onAddKv,
  onRemoveKv,
  onUpdateKv,
  onQuickAddBearer,
  onQuickAddContentType,
  onTimeoutChange,
}: {
  draft: HttpDraft;
  onBodyModeChange: (m: BodyMode) => void;
  onBodyChange: (body: string) => void;
  onAddKv: (target: "params" | "headers") => void;
  onRemoveKv: (target: "params" | "headers", id: string) => void;
  onUpdateKv: (target: "params" | "headers", id: string, patch: Partial<KVRow>) => void;
  onQuickAddBearer: () => void;
  onQuickAddContentType: () => void;
  onTimeoutChange: (ms: number) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<SubTab>("params");

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flexShrink: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "6px 12px 0",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        <TabButton label={t("Params")} count={draft.params.filter((p) => p.enabled && p.key).length} active={tab === "params"} onClick={() => setTab("params")} />
        <TabButton label={t("Headers")} count={draft.headers.filter((h) => h.enabled && h.key).length} active={tab === "headers"} onClick={() => setTab("headers")} />
        <TabButton label={t("Body")} active={tab === "body"} onClick={() => setTab("body")} />
        <div style={{ flex: 1 }} />
        <TimeoutControl valueMs={draft.options.timeoutMs} onChange={onTimeoutChange} />
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto", background: "var(--bg)" }}>
        {tab === "params" && (
          <KeyValueEditor
            rows={draft.params}
            onAdd={() => onAddKv("params")}
            onRemove={(id) => onRemoveKv("params", id)}
            onUpdate={(id, patch) => onUpdateKv("params", id, patch)}
            keyPlaceholder="param name"
            valuePlaceholder="value"
          />
        )}
        {tab === "headers" && (
          <KeyValueEditor
            rows={draft.headers}
            onAdd={() => onAddKv("headers")}
            onRemove={(id) => onRemoveKv("headers", id)}
            onUpdate={(id, patch) => onUpdateKv("headers", id, patch)}
            keyPlaceholder="header name"
            valuePlaceholder="value"
            footer={
              <div style={{ display: "flex", gap: 6, padding: "6px 12px 8px" }}>
                <button onClick={onQuickAddBearer} style={quickButtonStyle}>{t("Add Bearer Auth")}</button>
                <button onClick={onQuickAddContentType} style={quickButtonStyle}>{t("Add Content-Type")}</button>
              </div>
            }
          />
        )}
        {tab === "body" && (
          <BodyEditor mode={draft.bodyMode} body={draft.body} onModeChange={onBodyModeChange} onBodyChange={onBodyChange} />
        )}
      </div>
    </div>
  );
}

function TabButton({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        background: active ? "var(--bg)" : "transparent",
        border: "none",
        borderTop: active ? "2px solid var(--accent)" : "2px solid transparent",
        borderRight: active ? "1px solid var(--border)" : "1px solid transparent",
        borderLeft: active ? "1px solid var(--border)" : "1px solid transparent",
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
        marginBottom: -1,
        color: active ? "var(--text)" : "var(--text-muted)",
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span>{label}</span>
      {typeof count === "number" && count > 0 && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{count}</span>
      )}
    </button>
  );
}

const quickButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  height: 24,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  fontSize: 11,
  cursor: "pointer",
  transition: "color 0.12s, background 0.12s",
};

// ── Timeout control (gear icon → popover) ─────────────────────────────────

function TimeoutControl({ valueMs, onChange }: { valueMs: number; onChange: (ms: number) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const seconds = Math.round(valueMs / 1000);

  return (
    <div ref={ref} style={{ position: "relative", marginBottom: 4 }}>
      <Tooltip content={t("Timeout: {seconds}s").replace("{seconds}", String(seconds))}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 8px",
            height: 24,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span style={{ fontFamily: "var(--font-mono)" }}>{seconds}s</span>
        </button>
      </Tooltip>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 50,
            padding: 10,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            minWidth: 180,
          }}
        >
          <label style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("Timeout (seconds)")}</label>
          <input
            type="number"
            min={1}
            max={120}
            value={seconds}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isFinite(n)) return;
              const clamped = Math.max(1, Math.min(120, n));
              onChange(clamped * 1000);
            }}
            style={{
              width: "100%",
              padding: "4px 8px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            {[5, 15, 30, 60].map((s) => (
              <button
                key={s}
                onClick={() => onChange(s * 1000)}
                style={{
                  flex: 1,
                  padding: "3px 0",
                  background: seconds === s ? "var(--bg-selected)" : "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: seconds === s ? "var(--text)" : "var(--text-muted)",
                  fontSize: 10,
                  cursor: "pointer",
                }}
              >
                {s}s
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── KeyValue editor (Params + Headers) ────────────────────────────────────

function KeyValueEditor({
  rows,
  onAdd,
  onRemove,
  onUpdate,
  keyPlaceholder,
  valuePlaceholder,
  footer,
}: {
  rows: KVRow[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<KVRow>) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  footer?: React.ReactNode;
}) {
  return (
    <div>
      {rows.length === 0 ? (
        <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
          No entries
        </div>
      ) : (
        rows.map((row) => (
          <KvRow
            key={row.id}
            row={row}
            onUpdate={(patch) => onUpdate(row.id, patch)}
            onRemove={() => onRemove(row.id)}
            onToggleEnabled={() => onUpdate(row.id, { enabled: !row.enabled })}
            keyPlaceholder={keyPlaceholder}
            valuePlaceholder={valuePlaceholder}
          />
        ))
      )}
      <div style={{ padding: "6px 12px" }}>
        <button
          onClick={onAdd}
          style={{
            padding: "3px 10px",
            height: 24,
            background: "transparent",
            border: "1px dashed var(--border)",
            borderRadius: 6,
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          + Add row
        </button>
      </div>
      {footer}
    </div>
  );
}

function KvRow({
  row,
  onUpdate,
  onRemove,
  onToggleEnabled,
  keyPlaceholder,
  valuePlaceholder,
}: {
  row: KVRow;
  onUpdate: (patch: Partial<KVRow>) => void;
  onRemove: () => void;
  onToggleEnabled: () => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        opacity: row.enabled ? 1 : 0.55,
      }}
    >
      <input
        type="checkbox"
        checked={row.enabled}
        onChange={onToggleEnabled}
        style={{ flexShrink: 0, cursor: "pointer" }}
        title="Enable row"
      />
      <input
        type="text"
        value={row.key}
        placeholder={keyPlaceholder}
        onChange={(e) => onUpdate({ key: e.target.value })}
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          height: 24,
          padding: "0 6px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text)",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          outline: "none",
        }}
      />
      <input
        type="text"
        value={row.value}
        placeholder={valuePlaceholder}
        onChange={(e) => onUpdate({ value: e.target.value })}
        spellCheck={false}
        style={{
          flex: 1.4,
          minWidth: 0,
          height: 24,
          padding: "0 6px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text)",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          outline: "none",
        }}
      />
      <button
        onClick={onRemove}
        aria-label="Remove row"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          padding: 0,
          background: "transparent",
          border: "none",
          color: "var(--text-dim)",
          cursor: "pointer",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// ── Body editor ───────────────────────────────────────────────────────────

function BodyEditor({
  mode,
  body,
  onModeChange,
  onBodyChange,
}: {
  mode: BodyMode;
  body: string;
  onModeChange: (m: BodyMode) => void;
  onBodyChange: (b: string) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();

  const handleFormatJson = useCallback(() => {
    try {
      const parsed = JSON.parse(body);
      onBodyChange(JSON.stringify(parsed, null, 2));
    } catch (e) {
      toast.show({
        kind: "error",
        message: t("Invalid JSON: {error}").replace("{error}", e instanceof Error ? e.message : String(e)),
      });
    }
  }, [body, onBodyChange, toast, t]);

  return (
    <div>
      <div style={{ display: "flex", gap: 4, padding: "8px 12px 4px", alignItems: "center" }}>
        {(["none", "json", "raw"] as BodyMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            style={{
              padding: "3px 10px",
              height: 22,
              background: mode === m ? "var(--bg-selected)" : "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: mode === m ? "var(--text)" : "var(--text-muted)",
              fontSize: 11,
              fontWeight: mode === m ? 600 : 400,
              cursor: "pointer",
              textTransform: "uppercase",
              fontFamily: "var(--font-mono)",
            }}
          >
            {m}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {mode === "json" && body.trim() && (
          <>
            <button
              onClick={handleFormatJson}
              style={{
                padding: "2px 8px",
                height: 20,
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text-muted)",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
              title={t("Format JSON (pretty-print with 2-space indent)")}
            >
              {t("Format")}
            </button>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{validateJson(body)}</span>
          </>
        )}
      </div>
      {mode === "none" ? (
        <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
          {t("No request body")}
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          spellCheck={false}
          placeholder={mode === "json" ? '{\n  "key": "value"\n}' : "request body..."}
          style={{
            display: "block",
            width: "100%",
            minHeight: 120,
            maxHeight: 220,
            padding: "8px 12px",
            background: "var(--bg)",
            border: "none",
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
      )}
    </div>
  );
}

function validateJson(text: string): string {
  try {
    JSON.parse(text);
    return "✓";
  } catch {
    return "✗";
  }
}

// ── Draggable divider ─────────────────────────────────────────────────────

function DragDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        height: 1,
        background: "var(--border)",
        cursor: "row-resize",
        flexShrink: 0,
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--border)";
      }}
    />
  );
}

// ── Response section ──────────────────────────────────────────────────────

function ResponseSection({
  response,
  error,
  inFlight,
  onResend,
}: {
  response: HttpResponse | null;
  error: HttpError | null;
  inFlight: { id: string; startedAt: number } | null;
  onResend: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!inFlight) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [inFlight]);

  if (inFlight) {
    const elapsedMs = now - inFlight.startedAt;
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 16, gap: 10, color: "var(--text-muted)", fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Spinner />
          <span>{t("Request in flight...")}</span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
          {t("Elapsed: {ms}ms").replace("{ms}", String(elapsedMs))}
        </div>
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} onResend={onResend} />;
  }

  if (!response) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)", fontSize: 12 }}>
        {t("Send a request to see the response")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <StatusBadge status={response.status} />
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {response.durationMs}ms · {formatBytes(response.size)}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onResend}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 10px",
            height: 24,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {t("Resend")}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <ResponseBody response={response} />
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: number }) {
  const color =
    status >= 200 && status < 300 ? "#16a34a" :
    status >= 300 && status < 400 ? "#f59e0b" :
    "#ef4444";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: color,
        color: "#fff",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
      }}
    >
      {status}
    </span>
  );
}

// ── Error card ────────────────────────────────────────────────────────────

function ErrorCard({ error, onResend }: { error: HttpError; onResend: () => void }) {
  const { t } = useI18n();
  const titleByKind: Record<HttpError["kind"], string> = {
    timeout: t("Request timed out"),
    aborted: t("Request cancelled"),
    fetch_failed: t("Upstream failed"),
    body_too_large: t("Response too large"),
    invalid_url: t("Invalid URL"),
    invalid_json: t("Invalid JSON"),
    network: t("Network error"),
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 16, gap: 12 }}>
      <div
        style={{
          border: "1px solid #ef4444",
          background: "rgba(239, 68, 68, 0.08)",
          borderRadius: 8,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#ef4444" }}>
            {titleByKind[error.kind]}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>
          {error.message}
        </div>
        <div>
          <button
            onClick={onResend}
            style={{
              padding: "4px 12px",
              height: 26,
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              borderRadius: 6,
              color: "var(--bg)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Retry")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Response body ─────────────────────────────────────────────────────────

function ResponseBody({ response }: { response: HttpResponse }) {
  const { t } = useI18n();
  const contentType = response.contentType.toLowerCase();
  const body = response.body;

  // Image — server returns base64-encoded bytes for image/* content types.
  if (contentType.startsWith("image/") && response.bodyEncoding === "base64" && response.size < 2 * 1024 * 1024) {
    return (
      <div style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs aren't supported by next/image */}
        <img
          src={`data:${response.contentType};base64,${body}`}
          alt="response"
          style={{ maxWidth: "100%", maxHeight: 480, borderRadius: 6, border: "1px solid var(--border)" }}
        />
      </div>
    );
  }

  // JSON — pretty-print if it parses.
  if (contentType.includes("json") || looksLikeJson(body)) {
    return <JsonResponseViewer body={body} />;
  }

  // HTML — show as text + link to open in new tab.
  if (contentType.includes("html")) {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
    return (
      <div>
        <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, alignItems: "center" }}>
          <span>HTML</span>
          <a href={dataUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>
            {t("Open in new tab")}
          </a>
        </div>
        <CodeBlock text={body} />
      </div>
    );
  }

  // Plain text / unknown — just render.
  return <CodeBlock text={body} />;
}

// ── JSON response viewer (Format / Minify / Collapse / Expand / Copy) ──────

const HTTP_JSON_COLLAPSE_DEPTH = 3;
type JsonViewMode = "format" | "minify";

function JsonResponseViewer({ body }: { body: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [mode, setMode] = useState<JsonViewMode>("format");
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const [signatures, setSignatures] = useState<{ value: JsonValue; ignoredPrefix: string; ignoredSuffix: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-parse when the body changes; reset collapse state to default depth.
  useEffect(() => {
    if (body.length === 0) {
      setSignatures(null);
      setError(null);
      setCollapsedPaths(new Set());
      return;
    }
    const result = parseJsonTolerant(body);
    if (!result.ok) {
      setSignatures(null);
      setError(result.error);
      return;
    }
    setError(null);
    const value = result.value as JsonValue;
    setSignatures({ value, ignoredPrefix: result.ignoredPrefix, ignoredSuffix: result.ignoredSuffix });
    setCollapsedPaths(new Set(collectContainerPathsAtDepth(value, HTTP_JSON_COLLAPSE_DEPTH)));
  }, [body]);

  const handleCollapseAll = useCallback(() => {
    if (!signatures) return;
    setCollapsedPaths(new Set(collectAllContainerPaths(signatures.value)));
  }, [signatures]);

  const handleExpandAll = useCallback(() => setCollapsedPaths(new Set()), []);

  const handleTogglePath = useCallback((path: JsonPath) => {
    const key = jsonPathKey(path);
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleCopy = useCallback(async () => {
    if (!signatures) return;
    try {
      await copyText(minifyJson(signatures.value));
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Failed to copy") });
    }
  }, [signatures, t, toast]);

  const isFormat = mode === "format";
  const minifiedView = signatures ? minifyJson(signatures.value) : "";

  const showPrefixSuffixWarning = signatures && (signatures.ignoredPrefix || signatures.ignoredSuffix);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={jsonViewerToolbarStyle}>
        <JsonToolbarButton label={t("Format")} active={mode === "format"} onClick={() => setMode("format")} />
        <JsonToolbarButton label={t("Minify")} active={mode === "minify"} onClick={() => setMode("minify")} />
        <div style={jsonViewerDividerStyle} />
        <JsonToolbarButton label={t("Collapse all")} onClick={handleCollapseAll} disabled={!signatures || !isFormat} />
        <JsonToolbarButton label={t("Expand all")} onClick={handleExpandAll} disabled={!signatures || !isFormat} />
        <div style={{ flex: 1 }} />
        {showPrefixSuffixWarning && (
          <span style={jsonViewerWarnBadgeStyle} title={
            [
              signatures.ignoredPrefix && t("Ignored prefix: {prefix}").replace("{prefix}", signatures.ignoredPrefix),
              signatures.ignoredSuffix && t("Ignored suffix: {suffix}").replace("{suffix}", signatures.ignoredSuffix),
            ].filter(Boolean).join("\n")
          }>
            ⚠ {t("Trimmed")}
          </span>
        )}
        <JsonToolbarButton label={t("Copy")} onClick={handleCopy} disabled={!signatures} />
      </div>
      <div style={jsonViewerBodyStyle}>
        {error && !signatures ? (
          <>
            <div style={jsonViewerErrorBannerStyle}>
              {t("Response claims to be JSON but failed to parse: {error}").replace("{error}", error)}
            </div>
            <CodeBlock text={body} />
          </>
        ) : signatures && mode === "format" ? (
          <JsonTreeView value={signatures.value} collapsedPaths={collapsedPaths} onTogglePath={handleTogglePath} />
        ) : signatures ? (
          <span>{minifiedView}</span>
        ) : null}
      </div>
    </div>
  );
}

interface JsonToolbarButtonProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}

function JsonToolbarButton({ label, active, onClick, disabled }: JsonToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        background: active ? "var(--bg)" : "transparent",
        color: disabled ? "var(--text-dim)" : active ? "var(--text)" : "var(--text-muted)",
        border: "1px solid",
        borderColor: active ? "var(--border)" : "transparent",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.1s, color 0.1s",
      }}
    >
      {label}
    </button>
  );
}

const jsonViewerToolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 10px",
  background: "var(--bg)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const jsonViewerDividerStyle: React.CSSProperties = {
  width: 1,
  height: 16,
  background: "var(--border)",
  margin: "0 6px",
};

const jsonViewerWarnBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  marginRight: 4,
  background: "rgba(245, 158, 11, 0.12)",
  color: "#f59e0b",
  border: "1px solid rgba(245, 158, 11, 0.3)",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
  cursor: "help",
};

const jsonViewerBodyStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  background: "var(--bg)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.55,
  padding: "10px 14px",
  whiteSpace: "pre",
  color: "var(--text)",
};

const jsonViewerErrorBannerStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 11,
  color: "#f59e0b",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

function CodeBlock({ text }: { text: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: "10px 12px",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </pre>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        border: "2px solid var(--border)",
        borderTopColor: "var(--accent)",
        borderRadius: "50%",
        animation: "pi-http-spin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes pi-http-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}