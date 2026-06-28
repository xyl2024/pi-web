"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSessionUiState, useSessionLeafChange, resetSessionUi } from "@/hooks/sessionUiStore";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { TodoPanel } from "./TodoPanel";
import { PlaywrightDashboardPanel } from "./PlaywrightDashboardPanel";
import { CollectionPanel } from "./CollectionPanel";
import { TranslatePanel } from "./TranslatePanel";
import { ToolCallStatsPanel } from "./ToolCallStatsPanel";
import { HttpPanel } from "./HttpPanel";
import { JsonPanel } from "./JsonPanel";
import { CanvasPanel } from "./CanvasPanel";
import { useToolCallStatsView, useToolCallStatsScroll } from "@/hooks/toolCallStatsStore";

const TODO_TAB_ID = "todo:global";
const FAVORITES_TAB_ID = "favorites:global";
const TRANSLATE_TAB_ID = "translate:global";
const TOOL_CALLS_TAB_ID = "toolCalls:global";
const HTTP_TAB_ID = "http:global";
const JSON_TAB_ID = "json:global";
const CANVAS_TAB_ID = "canvas:global";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { Tooltip } from "./Tooltip";
import { PromptsConfig } from "./PromptsConfig";
import { SettingsModal } from "./SettingsModal";
import { PayloadsModal } from "./PayloadsModal";
import { BranchNavigator } from "./BranchNavigator";
import { CommandPalette } from "./CommandPalette";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { SessionInfo, SessionSearchResult } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import { sendAgentCommand } from "@/lib/agent-client";

interface ToolInfo {
  name: string;
  description: string;
  active: boolean;
}

// Drag-resize limits + defaults. Widths are in CSS pixels.
const DEFAULT_LEFT_WIDTH = 260;
const LEFT_MIN = 200;
const LEFT_MAX = 600;
const RIGHT_MIN = 300;
const RIGHT_MAX = 1000;
const STORAGE_KEY_LEFT = "pi-sidebar-width";
const STORAGE_KEY_RIGHT = "pi-right-panel-width";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Default right-panel width is 42% of viewport, clamped to the allowed range.
const defaultRightWidth = (): number => {
  if (typeof window === "undefined") return 600;
  return clamp(Math.round(window.innerWidth * 0.42), RIGHT_MIN, RIGHT_MAX);
};

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const toast = useToast();
  const cm = useContextMenu();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [pendingScrollEntryId, setPendingScrollEntryId] = useState<string | null>(null);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [promptsConfigOpen, setPromptsConfigOpen] = useState(false);
  const [settingsConfigOpen, setSettingsConfigOpen] = useState(false);
  const [payloadsOpen, setPayloadsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Focus mode — hides the left sidebar and forces the right panel into a
  // 1:2 (center : right) split. Toggled by the focus button at the bottom of
  // the right-side button bar.
  const [focused, setFocused] = useState(false);
  const toggleFocus = useCallback(() => {
    setFocused((v) => {
      if (v) setSidebarOpen(true);
      return !v;
    });
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Session-level UI state (branch tree, system prompt, agents files, session
  // stats, context usage) is owned by useAgentSession in ChatWindow and
  // published to a module-level store. The top bar / branch navigator / context
  // panel here read from that store.
  const { branchTree, branchActiveLeafId, systemPrompt, agentsFiles } = useSessionUiState();
  const handleBranchLeafChange = useSessionLeafChange();
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  // agentsFiles is an array; AppShell owns the "which one is currently shown"
  // index. Reset to 0 whenever the list contents change. The store's
  // content-based change check guards against the IIFE-derived agentsFiles
  // value re-firing this effect on every render.
  const [selectedAgentsFileIndex, setSelectedAgentsFileIndex] = useState<number>(0);
  useEffect(() => {
    setSelectedAgentsFileIndex(0);
  }, [agentsFiles]);

  // Tools list — fetched once per session, cached for button clicks
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const toolsBtnRef = useRef<HTMLButtonElement>(null);

  const fetchTools = useCallback(async (sessionId: string) => {
    try {
      const result = await sendAgentCommand<ToolInfo[]>(sessionId, { type: "get_tools" });
      setTools(result ?? []);
    } catch {
      setTools([]);
    }
  }, []);

  // Fetch tools when session changes (sessionKey bumps on session switch or URL restore)
  useEffect(() => {
    if (!selectedSession?.id) return;
    fetchTools(selectedSession.id);
  }, [sessionKey, selectedSession?.id, fetchTools]);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "context" | "tools" | "dashboard" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "context" | "tools" | "dashboard") => {
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const active = document.activeElement;
      const isEditable =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      // Ctrl+B — toggle left sidebar (skipped when an editor is focused)
      if (mod && e.key === "b" && !e.altKey) {
        if (!isEditable) {
          e.preventDefault();
          setSidebarOpen((v) => !v);
        }
        return;
      }
      // Ctrl+Alt+B — toggle right sidebar
      if (mod && e.altKey && e.key === "b") {
        e.preventDefault();
        setRightPanelState((v) => v === "closed" ? "normal" : "closed");
        return;
      }
      // Ctrl+K — command palette (skipped when an editor is focused)
      if (mod && e.key === "k") {
        if (!isEditable) {
          e.preventDefault();
          setPaletteOpen((v) => !v);
        }
        return;
      }
      // Space — focus chat input when not already focused
      if (
        e.key === " " &&
        !e.ctrlKey && !e.metaKey && !e.altKey &&
        !paletteOpen &&
        chatInputRef.current
      ) {
        if (!isEditable) {
          e.preventDefault();
          chatInputRef.current.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelState, setRightPanelState] = useState<"closed" | "normal" | "expanded">("closed");

  // Favorites — global list of session IDs, shared between the sidebar indicator
  // and the right-panel CollectionPanel so the two views stay in sync.
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/favorites")
      .then((r) => r.json())
      .then((d: { sessionIds?: string[] }) => {
        if (Array.isArray(d.sessionIds)) setFavoriteIds(d.sessionIds);
      })
      .catch(() => {});
  }, []);
  const toggleSessionFavorite = useCallback(async (sessionId: string) => {
    const prev = favoriteIds;
    const next = prev.includes(sessionId)
      ? prev.filter((id) => id !== sessionId)
      : [...prev, sessionId];
    setFavoriteIds(next);
    try {
      const res = await fetch("/api/favorites", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setFavoriteIds(prev);
      toast.show({ kind: "error", message: t("Failed to update favorite") });
    }
  }, [favoriteIds, t, toast]);

  // ── Drag-resize state ────────────────────────────────────────────
  const [leftWidth, setLeftWidth] = useState<number>(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState<number>(600);
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  // Hydrate widths from localStorage on mount. SSR-safe: defaults are
  // used on the first render, then we sync from storage.
  useEffect(() => {
    try {
      const l = localStorage.getItem(STORAGE_KEY_LEFT);
      if (l) {
        const n = parseInt(l, 10);
        if (Number.isFinite(n) && n >= LEFT_MIN && n <= LEFT_MAX) setLeftWidth(n);
      }
      const r = localStorage.getItem(STORAGE_KEY_RIGHT);
      if (r) {
        const n = parseInt(r, 10);
        if (Number.isFinite(n) && n >= RIGHT_MIN && n <= RIGHT_MAX) {
          setRightWidth(n);
        } else {
          setRightWidth(defaultRightWidth());
        }
      } else {
        setRightWidth(defaultRightWidth());
      }
    } catch {
      /* localStorage unavailable — keep defaults */
    }
  }, []);

  // If a drag is in flight when the component unmounts, drop the listeners.
  useEffect(() => () => cleanupDragRef.current?.(), []);

  // Left handle — drag the boundary between sidebar and center.
  const startDragLeft = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingLeft(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const startX = e.clientX;
    const startWidth = leftWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setLeftWidth(clamp(startWidth + delta, LEFT_MIN, LEFT_MAX));
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsDraggingLeft(false);
      cleanupDragRef.current = null;
    };
    const onUp = () => {
      cleanup();
      setLeftWidth((cur) => {
        try { localStorage.setItem(STORAGE_KEY_LEFT, String(cur)); } catch {}
        return cur;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cleanupDragRef.current = cleanup;
  }, [leftWidth]);

  // Right handle — drag the boundary between center and right panel.
  const startDragRight = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingRight(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const startX = e.clientX;
    const startWidth = rightWidth;
    const onMove = (ev: MouseEvent) => {
      // Cursor moving left → right panel grows (delta is startX - clientX).
      const delta = startX - ev.clientX;
      setRightWidth(clamp(startWidth + delta, RIGHT_MIN, RIGHT_MAX));
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsDraggingRight(false);
      cleanupDragRef.current = null;
    };
    const onUp = () => {
      cleanup();
      setRightWidth((cur) => {
        try { localStorage.setItem(STORAGE_KEY_RIGHT, String(cur)); } catch {}
        return cur;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cleanupDragRef.current = cleanup;
  }, [rightWidth]);

  // Double-click the handle to reset to the default width.
  const resetLeftWidth = useCallback(() => {
    setLeftWidth(DEFAULT_LEFT_WIDTH);
    try { localStorage.setItem(STORAGE_KEY_LEFT, String(DEFAULT_LEFT_WIDTH)); } catch {}
  }, []);

  const resetRightWidth = useCallback(() => {
    const def = defaultRightWidth();
    setRightWidth(def);
    try { localStorage.setItem(STORAGE_KEY_RIGHT, String(def)); } catch {}
  }, []);

  const handleAtMention = useCallback((filePath: string) => {
    chatInputRef.current?.insertText("`" + filePath + "`");
  }, []);

  const [initialSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !searchParams.get("session"));
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  const handleCwdChange = useCallback((cwd: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd || suppressCwdBumpRef.current) return;
    // Close any session that belongs to a different cwd — it no longer
    // matches the selected project directory.
    setSelectedSession((prev) => {
      if (prev && prev.cwd !== cwd) return null;
      return prev;
    });
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    resetSessionUi();
    setTools([]);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    resetSessionUi();
    setTools([]);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
      setTimeout(() => { suppressCwdBumpRef.current = false; }, 0);
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router]);

  // Command palette: convert search result to SessionInfo and open it
  const handleSelectSearchResult = useCallback((result: SessionSearchResult) => {
    const sessionInfo: SessionInfo = {
      path: "",
      id: result.id,
      cwd: result.cwd,
      name: result.name,
      created: result.modified,
      modified: result.modified,
      messageCount: 0,
      firstMessage: "",
    };
    setPendingScrollEntryId(result.firstMatchEntryId ?? null);
    handleSelectSession(sessionInfo);
  }, [handleSelectSession]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    resetSessionUi();
    setTools([]);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  // Called when /new slash command is triggered
  const handleSlashNew = useCallback(() => {
    const cwd = selectedSession?.cwd ?? activeCwd;
    if (!cwd) return;
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    handleNewSession(tempId, cwd);
  }, [selectedSession?.cwd, activeCwd, handleNewSession]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  // Called by SchedulerPanel "Open session" — fetches minimal session info
  // and routes through the same selection path as the sidebar.
  const handleOpenScheduledSession = useCallback((sessionId: string) => {
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { info?: SessionInfo };
        if (!data.info) return;
        handleSelectSession(data.info);
      } catch {
        // Fallback: navigate via URL so the page rehydrates from the session file
        router.replace(`?session=${encodeURIComponent(sessionId)}`, { scroll: false });
      }
    })();
  }, [handleSelectSession, router]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      resetSessionUi();
      setTools([]);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      if (prev.find((t) => t.id === tabId)) return prev;
      return [...prev, { kind: "file", id: tabId, label: fileName, filePath }];
    });
    setActiveFileTabId(tabId);
    setRightPanelState("normal");
  }, []);

  // Open the todos tab. If it's already in the tab strip, just activate it;
  // if not, insert it at the leftmost position and activate it. Mirrors
  // handleOpenFile so existing file tabs are never displaced.
  const handleOpenTodoTab = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some((t) => t.kind === "todo")) return prev;
      return [{ kind: "todo", id: TODO_TAB_ID, label: t("Todos") }, ...prev];
    });
    setActiveFileTabId(TODO_TAB_ID);
    setRightPanelState("normal");
  }, [t]);

  // Default-open the Todos tab on initial mount. Covers both first entry
  // and refresh (a refresh tears down and remounts the tree, so this
  // runs again). After mount, the user's open/close choices take over.
  useEffect(() => {
    handleOpenTodoTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the favorites tab — same pattern as todos / file tabs.
  const handleOpenFavoritesTab = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some((t) => t.kind === "favorites")) return prev;
      return [{ kind: "favorites", id: FAVORITES_TAB_ID, label: t("Favorites") }, ...prev];
    });
    setActiveFileTabId(FAVORITES_TAB_ID);
    setRightPanelState("normal");
  }, [t]);

  // Open the translate tab — same pattern as todos / favorites.
  const handleOpenTranslateTab = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some((t) => t.kind === "translate")) return prev;
      return [{ kind: "translate", id: TRANSLATE_TAB_ID, label: t("Translate") }, ...prev];
    });
    setActiveFileTabId(TRANSLATE_TAB_ID);
    setRightPanelState("normal");
  }, [t]);

  // Open the tool-calls tab. Toggles: clicking when it's already the active
  // tab hides the right panel entirely; otherwise activate (or create) the
  // tab. Mirrors the original drawer toggle behaviour.
  const handleOpenToolCallsTab = useCallback(() => {
    const alreadyActive = activeFileTabId === TOOL_CALLS_TAB_ID && rightPanelState !== "closed";
    if (alreadyActive) {
      setActiveFileTabId(null);
      setRightPanelState("closed");
      return;
    }
    setFileTabs((prev) => {
      if (prev.some((tab) => tab.kind === "toolCalls")) return prev;
      return [{ kind: "toolCalls", id: TOOL_CALLS_TAB_ID, label: t("Tool Calls") }, ...prev];
    });
    setActiveFileTabId(TOOL_CALLS_TAB_ID);
    setRightPanelState("normal");
  }, [activeFileTabId, rightPanelState, t]);

  // Open the HTTP debug tab — same pattern as todos / favorites / translate.
  const handleOpenHttpTab = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some((tab) => tab.kind === "http")) return prev;
      return [{ kind: "http", id: HTTP_TAB_ID, label: t("HTTP") }, ...prev];
    });
    setActiveFileTabId(HTTP_TAB_ID);
    setRightPanelState("normal");
  }, [t]);

  // Open the JSON formatter tab — same pattern as HTTP.
  const handleOpenJsonTab = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some((tab) => tab.kind === "json")) return prev;
      return [{ kind: "json", id: JSON_TAB_ID, label: t("JSON") }, ...prev];
    });
    setActiveFileTabId(JSON_TAB_ID);
    setRightPanelState("normal");
  }, [t]);

  // Open the canvas tab — single global whiteboard, persisted in localStorage.
  const handleOpenCanvasTab = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some((tab) => tab.kind === "canvas")) return prev;
      return [{ kind: "canvas", id: CANVAS_TAB_ID, label: t("Canvas") }, ...prev];
    });
    setActiveFileTabId(CANVAS_TAB_ID);
    setRightPanelState("normal");
  }, [t]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelState("closed");
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  // Close every tab strictly to the left of `tabId` (the right-clicked one).
  // If the active tab is being closed, fall back to `tabId` (still open).
  const handleCloseLeftTabs = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx <= 0) return prev;
      return prev.slice(idx);
    });
    setActiveFileTabId((cur) => {
      if (cur === null) return cur;
      const activeIdx = fileTabs.findIndex((t) => t.id === cur);
      const refIdx = fileTabs.findIndex((t) => t.id === tabId);
      if (activeIdx >= 0 && activeIdx < refIdx) return tabId;
      return cur;
    });
  }, [fileTabs]);

  // Close every tab strictly to the right of `tabId`. If the active tab is
  // being closed, fall back to `tabId`.
  const handleCloseRightTabs = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1 || idx === prev.length - 1) return prev;
      return prev.slice(0, idx + 1);
    });
    setActiveFileTabId((cur) => {
      if (cur === null) return cur;
      const activeIdx = fileTabs.findIndex((t) => t.id === cur);
      const refIdx = fileTabs.findIndex((t) => t.id === tabId);
      if (activeIdx > refIdx && refIdx >= 0) return tabId;
      return cur;
    });
  }, [fileTabs]);

  // Close every tab other than `tabId`. The right-clicked tab is preserved
  // (and becomes the active one if it wasn't already), so the panel never
  // collapses from this action.
  const handleCloseOtherTabs = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      if (!prev.some((t) => t.id === tabId)) return prev;
      return prev.filter((t) => t.id === tabId);
    });
    setActiveFileTabId(tabId);
  }, []);

  // Build the per-tab right-click menu. Single tab → no batch actions shown.
  const handleTabContextMenu = useCallback((tabId: string, x: number, y: number) => {
    const idx = fileTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const hasLeft = idx > 0;
    const hasRight = idx < fileTabs.length - 1;
    const hasOthers = fileTabs.length > 1;
    const items: ContextMenuItem[] = [
      { key: "close", label: t("Close tab"), onSelect: () => handleCloseFileTab(tabId) },
      { key: "close-left", label: t("Close tabs to the left"), onSelect: () => handleCloseLeftTabs(tabId), disabled: !hasLeft },
      { key: "close-right", label: t("Close tabs to the right"), onSelect: () => handleCloseRightTabs(tabId), disabled: !hasRight },
      { key: "close-others", label: t("Close other tabs"), onSelect: () => handleCloseOtherTabs(tabId), disabled: !hasOthers },
    ];
    cm.open({ x, y, items });
  }, [fileTabs, t, cm, handleCloseFileTab, handleCloseLeftTabs, handleCloseRightTabs, handleCloseOtherTabs]);

  const handleFileDeleted = useCallback((filePath: string) => {
    handleCloseFileTab(`file:${filePath}`);
  }, [handleCloseFileTab]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        initialSessionId={initialSessionId}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
        onOpenSearch={() => setPaletteOpen(true)}
        onFileDeleted={handleFileDeleted}
        onOpenScheduledSession={handleOpenScheduledSession}
        favoriteIds={favoriteIds}
        onToggleFavorite={toggleSessionFavorite}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          {
            label: t("Models"),
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
            label: t("Skills"),
            onClick: () => setSkillsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
          {
            label: t("Prompts"),
            onClick: () => setPromptsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5V4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5" />
                <path d="M8 7h8" />
                <path d="M8 11h6" />
              </svg>
            ),
          },
          {
            label: t("Settings"),
            onClick: () => setSettingsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: React.ReactNode }[]).map(({ label, onClick, disabled, icon }) => (
          <Tooltip key={label} content={label}>
          <button
            onClick={onClick}
            disabled={disabled}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              height: 32, padding: 0, background: "none", border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
            {label}
          </button>
          </Tooltip>
        ))}
      </div>
    </>
  );

  return (
    <>
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className="sidebar-overlay-backdrop"
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${(sidebarOpen && !focused) ? "" : " sidebar-closed"}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          width: (sidebarOpen && !focused) ? leftWidth : 0,
          minWidth: (sidebarOpen && !focused) ? leftWidth : 0,
          transition: isDraggingLeft ? "none" : undefined,
        }}
      >
        {sidebarContent}
      </div>

      {/* Drag handle: left ↔ center. Only visible when sidebar is open. */}
      {sidebarOpen && !focused && (
        <div
          className={`resize-handle${isDraggingLeft ? " dragging" : ""}`}
          onMouseDown={startDragLeft}
          onDoubleClick={resetLeftWidth}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: (rightPanelState === "expanded" && !focused) ? "none" : "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)", overflow: "visible", zIndex: 45 }}>
          <Tooltip content={sidebarOpen ? t("Hide sidebar") : t("Show sidebar")}>
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          </Tooltip>
          {showChat && (
            <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <button
                ref={systemBtnRef}
                onClick={() => toggleTopPanel("system")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                <span>{t("System")}</span>
              </button>
              <Tooltip content={agentsFiles.length > 0 ? `${agentsFiles.length} AGENTS.md file(s)` : t("No AGENTS.md files found")}>
              <button
                onClick={() => toggleTopPanel("context")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "context" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "context" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: agentsFiles.length > 0 ? "pointer" : "default",
                  color: agentsFiles.length > 0 ? (activeTopPanel === "context" ? "var(--text)" : "var(--text-muted)") : "var(--text-dim)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                  opacity: agentsFiles.length > 0 ? 1 : 0.5,
                }}
                onMouseEnter={(e) => { if (agentsFiles.length > 0) e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = agentsFiles.length > 0 ? (activeTopPanel === "context" ? "var(--text)" : "var(--text-muted)") : "var(--text-dim)"; }}
                >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  <line x1="8" y1="7" x2="16" y2="7" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
                <span>{t("Context")}</span>
                {agentsFiles.length > 1 && (
                  <span style={{ fontSize: 10, opacity: 0.7 }}>({agentsFiles.length})</span>
                )}
              </button>
              </Tooltip>
              <Tooltip content={tools.length > 0 ? `${tools.filter((t) => t.active).length} / ${tools.length} ${t("Active").toLowerCase()}` : t("No tools available for this session")}>
              <button
                ref={toolsBtnRef}
                onClick={() => toggleTopPanel("tools")}
                disabled={tools.length === 0}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "tools" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "tools" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: tools.length > 0 ? "pointer" : "default",
                  color: tools.length > 0 ? (activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)") : "var(--text-dim)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                  opacity: tools.length > 0 ? 1 : 0.5,
                }}
                onMouseEnter={(e) => { if (tools.length > 0) e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = tools.length > 0 ? (activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)") : "var(--text-dim)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                <span>{t("Tools")}</span>
                {tools.length > 0 && (
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{tools.filter((t) => t.active).length}</span>
                )}
              </button>
              </Tooltip>
              <Tooltip content={activeTopPanel === "dashboard" ? t("Hide dashboard") : t("Open dashboard")}>
              <button
                onClick={() => toggleTopPanel("dashboard")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "dashboard" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "dashboard" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "dashboard" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "dashboard" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="6" />
                  <line x1="2" y1="8" x2="14" y2="8" />
                  <path d="M8 2a8 8 0 0 1 0 12" />
                  <path d="M8 2a8 8 0 0 0 0 12" />
                </svg>
                <span>{t("Browser")}</span>
              </button>
              </Tooltip>
              {selectedSession?.id && (
                <Tooltip content={t("View raw provider API requests captured for this session")}>
                <button
                  onClick={() => setPayloadsOpen(true)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    height: "100%", padding: "0 12px",
                    background: "none", border: "none",
                    borderTop: "2px solid transparent",
                    borderRight: "1px solid var(--border)",
                    cursor: "pointer",
                    color: "var(--text-muted)",
                    fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                    fontFamily: "var(--font-mono)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                  <span>{t("API")}</span>
                </button>
                </Tooltip>
              )}
            </div>
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          <CollapsiblePanel
            open={activeTopPanel !== null}
            style={{
              position: "fixed",
              top: topPanelPos?.top ?? 0,
              left: topPanelPos?.left ?? 0,
              width: topPanelPos?.width ?? "100%",
              zIndex: 500,
            }}
          >
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("System prompt is empty (tools are disabled)")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("Send a message to load the system prompt. (Because of Pi's design: system prompt words are not pre-set; they are only constructed when needed.)")}
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "context" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {agentsFiles.length === 0 ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("No AGENTS.md files found for this project")}
                    </div>
                  ) : (
                    <>
                      {agentsFiles.length > 1 && (
                        <div style={{ display: "flex", gap: 4, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
                          {agentsFiles.map((file, idx) => (
                            <button
                              key={file.path}
                              onClick={() => setSelectedAgentsFileIndex(idx)}
                              style={{
                                padding: "4px 10px",
                                fontSize: 11,
                                background: selectedAgentsFileIndex === idx ? "var(--bg-selected)" : "none",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                cursor: "pointer",
                                color: selectedAgentsFileIndex === idx ? "var(--text)" : "var(--text-muted)",
                                transition: "background 0.1s, color 0.1s",
                              }}
                            >
                              {file.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{
                        maxHeight: "min(600px, 75vh)",
                        overflowY: "auto",
                        padding: "12px 16px",
                        color: "var(--text-muted)",
                        fontSize: 12,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                        fontFamily: "var(--font-mono)",
                      }}>
                        {agentsFiles[selectedAgentsFileIndex]?.content}
                      </div>
                    </>
                  )}
                </div>
              )}
              {activeTopPanel === "tools" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {tools.length === 0 ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("Loading tools...")}
                    </div>
                  ) : (() => {
                    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
                    return (
                      <div style={{ maxHeight: "min(600px, 75vh)", overflowY: "auto" }}>
                        {sorted.map((tool) => (
                          <div
                            key={tool.name}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 10,
                              padding: "10px 16px",
                              borderBottom: "1px solid var(--border)",
                            }}
                          >
                            <div style={{
                              width: 7, height: 7, borderRadius: "50%",
                              background: tool.active ? "var(--accent)" : "var(--text-dim)",
                              flexShrink: 0, marginTop: 4,
                            }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>
                                {tool.name}
                              </div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>
                                {tool.description || t("No description")}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}
              {activeTopPanel === "dashboard" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  height: "min(600px, 75vh)",
                  overflow: "hidden",
                }}>
                  <PlaywrightDashboardPanel />
                </div>
              )}
          </CollapsiblePanel>

        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              scrollToEntryId={pendingScrollEntryId}
              onScrollComplete={() => setPendingScrollEntryId(null)}
              onNewSessionRequest={handleSlashNew}
            />
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                {t("Select a session from the sidebar")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("Get Started")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("Select a project directory from the sidebar")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{t("Add models via the Models button at the bottom")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {/* Drag handle: center ↔ right. Only when right panel is in `normal`. */}
      {rightPanelState === "normal" && !focused && (
        <div
          className={`resize-handle${isDraggingRight ? " dragging" : ""}`}
          onMouseDown={startDragRight}
          onDoubleClick={resetRightWidth}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        className={`right-panel-container right-panel-${focused ? "expanded" : rightPanelState}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          width: !focused && rightPanelState === "normal" ? rightWidth : undefined,
          minWidth: !focused && rightPanelState === "normal" ? rightWidth : undefined,
          flex: focused ? 2 : undefined,
          transition: isDraggingRight ? "none" : undefined,
        }}
      >
        {/* Right panel tab bar */}
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
              onContextMenu={handleTabContextMenu}
            />
          </div>
        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {activeFileTab?.kind === "todo" ? (
            <TodoPanel />
          ) : activeFileTab?.kind === "favorites" ? (
            <CollectionPanel
              favoriteIds={favoriteIds}
              onSelectSession={handleSelectSession}
              onToggleFavorite={toggleSessionFavorite}
            />
          ) : activeFileTab?.kind === "translate" ? (
            <TranslatePanel />
          ) : activeFileTab?.kind === "toolCalls" ? (
            <ToolCallStatsTabBody />
          ) : activeFileTab?.kind === "http" ? (
            <HttpPanel />
          ) : activeFileTab?.kind === "json" ? (
            <JsonPanel />
          ) : activeFileTab?.kind === "file" ? (
            <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} />
          ) : activeFileTab?.kind === "canvas" ? (
            <CanvasPanel />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              {t("No file open")}
            </div>
          )}
        </div>
      </div>

      {/* Right button bar — dedicated column for panel toggle buttons, always visible */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        width: 36,
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
      }}>
        {/* Show/hide file panel — always visible */}
        <Tooltip content={rightPanelState !== "closed" ? t("Hide file panel") : t("Show file panel")}>
        <button
          onClick={() => setRightPanelState((v) => v === "closed" ? "normal" : "closed")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, padding: 0,
            background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
            color: rightPanelState !== "closed" ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer", transition: "color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelState !== "closed" ? "var(--text)" : "var(--text-muted)"; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </button>
        </Tooltip>
        {/* Open todos — always visible */}
        <Tooltip content={t("Open todos")}>
        <button
          onClick={handleOpenTodoTab}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, padding: 0,
            background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
            color: activeFileTab?.kind === "todo" ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer", transition: "color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = activeFileTab?.kind === "todo" ? "var(--text)" : "var(--text-muted)"; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <polyline points="8 12 11 15 17 9" />
          </svg>
        </button>
        </Tooltip>
        {/* Open canvas — single global whiteboard */}
        <Tooltip content={activeFileTab?.kind === "canvas" ? t("Hide canvas") : t("Open canvas")}>
          <button
            onClick={handleOpenCanvasTab}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
              color: activeFileTab?.kind === "canvas" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = activeFileTab?.kind === "canvas" ? "var(--text)" : "var(--text-muted)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18.37 2.63a1.75 1.75 0 0 1 2.48 2.48L9 16.96l-4.5 1.04 1.04-4.5Z" />
              <path d="M14 7l3 3" />
            </svg>
          </button>
        </Tooltip>
        {/* Open translate — always visible */}
        <Tooltip content={t("Open translate")}>
        <button
          onClick={handleOpenTranslateTab}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, padding: 0,
            background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
            color: activeFileTab?.kind === "translate" ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer", transition: "color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = activeFileTab?.kind === "translate" ? "var(--text)" : "var(--text-muted)"; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5h12" />
            <path d="M9 3v2" />
            <path d="M5 5c0 4 3 7 6 9" />
            <path d="M11 5c0 3-2 6-6 8" />
            <path d="M14 21l5-12 5 12" />
            <path d="M15.5 17h7" />
          </svg>
        </button>
        </Tooltip>
        {/* Open HTTP debug panel */}
        <Tooltip content={t("HTTP")}>
          <button
            onClick={handleOpenHttpTab}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
              color: activeFileTab?.kind === "http" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = activeFileTab?.kind === "http" ? "var(--text)" : "var(--text-muted)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </Tooltip>
        {/* Open JSON formatter panel */}
        <Tooltip content={t("JSON")}>
          <button
            onClick={handleOpenJsonTab}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
              color: activeFileTab?.kind === "json" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = activeFileTab?.kind === "json" ? "var(--text)" : "var(--text-muted)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3 H6 a2 2 0 0 0 -2 2 v3 a2 2 0 0 1 -2 2 a2 2 0 0 1 2 2 v3 a2 2 0 0 0 2 2 h2" />
              <path d="M16 3 h2 a2 2 0 0 1 2 2 v3 a2 2 0 0 0 2 2 a2 2 0 0 0 -2 2 v3 a2 2 0 0 1 -2 2 h-2" />
            </svg>
          </button>
        </Tooltip>
        {/* Expand/collapse — only when panel is open and has tabs */}
        {rightPanelState !== "closed" && fileTabs.length > 0 && (
          <Tooltip content={rightPanelState === "expanded" ? t("Collapse file panel") : t("Expand file panel")}>
          <button
            onClick={() => setRightPanelState((v) => v === "expanded" ? "normal" : "expanded")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "transparent", border: "none",
              color: "var(--text-muted)", cursor: "pointer", transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {rightPanelState === "expanded" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="13 7 18 12 13 17" />
                <polyline points="6 7 11 12 6 17" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            )}
          </button>
          </Tooltip>
        )}
        {/* Favorites + Tool Calls + Focus — grouped at the bottom of the button bar */}
        <div style={{ marginTop: "auto" }}>
          {/* Open favorites — always visible */}
          <Tooltip content={t("Open favorites")}>
          <button
            onClick={handleOpenFavoritesTab}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
              color: activeFileTab?.kind === "favorites" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = activeFileTab?.kind === "favorites" ? "var(--text)" : "var(--text-muted)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill={activeFileTab?.kind === "favorites" ? "var(--accent)" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
          </Tooltip>
          {/* Open tool calls — always visible; shows running/total badge */}
          <ToolCallsVerticalButton active={activeFileTab?.kind === "toolCalls"} onClick={handleOpenToolCallsTab} />
          {/* Focus mode toggle */}
          <Tooltip content={focused ? t("Exit focus") : t("Focus")}>
            <button
              onClick={toggleFocus}
              aria-label={focused ? t("Exit focus") : t("Focus")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 36, height: 36, padding: 0,
                background: focused ? "var(--bg-selected)" : "transparent",
                border: "none",
                color: focused ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer", transition: "color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = focused ? "var(--text)" : "var(--text-muted)"; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {skillsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <SkillsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {promptsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <PromptsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setPromptsConfigOpen(false)} />
    )}
    {settingsConfigOpen && <SettingsModal onClose={() => setSettingsConfigOpen(false)} />}
    {payloadsOpen && selectedSession?.id && (
      <PayloadsModal sessionId={selectedSession.id} onClose={() => setPayloadsOpen(false)} />
    )}
    <CommandPalette
      open={paletteOpen}
      onClose={() => setPaletteOpen(false)}
      cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
      onSelectSession={handleSelectSearchResult}
      t={t}
    />
    </>
  );
}

// ── Tool-calls vertical button ────────────────────────────────────────────
// Mirrors the style of the other right-bar buttons (todos / favorites /
// translate) and overlays a tiny live badge for the running / total count.

function ToolCallsVerticalButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const { snapshot } = useToolCallStatsView();
  const { runningCount, totalCount } = snapshot;

  const badgeColor = runningCount > 0
    ? "var(--accent)"
    : totalCount > 0
      ? "var(--text-muted)"
      : null;

  return (
    <Tooltip content={t("Tool Calls")}>
      <button
        onClick={onClick}
        style={{
          position: "relative",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, padding: 0,
          background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
          color: active ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", transition: "color 0.12s",
          gap: 1,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = active ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="2" y1="14" x2="2" y2="9" />
          <line x1="7" y1="14" x2="7" y2="5" />
          <line x1="12" y1="14" x2="12" y2="2" />
          <line x1="0.5" y1="14.5" x2="15.5" y2="14.5" />
        </svg>
        {badgeColor !== null && (
          <span style={{
            fontSize: 9, lineHeight: "10px", fontFamily: "var(--font-mono)", fontWeight: 600,
            color: badgeColor,
          }}>
            {runningCount > 0 ? `${runningCount}/${totalCount}` : totalCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

// ── Tool-calls tab body ───────────────────────────────────────────────────
// Wires the published snapshot + scroll callback into the panel component.

function ToolCallStatsTabBody() {
  const { snapshot } = useToolCallStatsView();
  const scrollToToolCall = useToolCallStatsScroll();
  return <ToolCallStatsPanel snapshot={snapshot} onScrollToToolCall={scrollToToolCall} />;
}
