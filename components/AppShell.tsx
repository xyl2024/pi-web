"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { TodoPanel } from "./TodoPanel";

const TODO_TAB_ID = "todo:global";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { Tooltip } from "./Tooltip";
import { PromptsConfig } from "./PromptsConfig";
import { SettingsModal } from "./SettingsModal";
import { PayloadsModal } from "./PayloadsModal";
import { BranchNavigator } from "./BranchNavigator";
import { CommandPalette } from "./CommandPalette";
import { useTheme, PRESETS, PRESET_LABELS } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo, SessionTreeNode, AgentsFile, SessionSearchResult } from "@/lib/types";
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
  const { preset, setPreset } = useTheme();
  const { locale, toggleLocale, t } = useI18n();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
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
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Agents files (AGENTS.md) — populated by ChatWindow, displayed in context panel
  const [agentsFiles, setAgentsFiles] = useState<AgentsFile[]>([]);
  const [selectedAgentsFileIndex, setSelectedAgentsFileIndex] = useState<number>(0);
  const handleAgentsFilesChange = useCallback((files: AgentsFile[]) => {
    setAgentsFiles(files);
    setSelectedAgentsFileIndex(0);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<{ tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null>(null);
  const handleSessionStatsChange = useCallback((stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => {
    setSessionStats(stats);
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

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
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "context" | "tools" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "context" | "tools") => {
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

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.insertText("`" + relativePath + "`");
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
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setAgentsFiles([]);
    setTools([]);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setAgentsFiles([]);
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
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setAgentsFiles([]);
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
        const data = (await res.json()) as { session?: SessionInfo };
        if (!data.session) return;
        handleSelectSession(data.session);
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
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setAgentsFiles([]);
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

  // Top-right toggle: open todos on first click, close them on the next.
  // If closing leaves no tabs, the right panel collapses too.
  const handleToggleTodoTab = useCallback(() => {
    if (fileTabs.some((t) => t.kind === "todo")) {
      setFileTabs((prev) => prev.filter((t) => t.kind !== "todo"));
      setActiveFileTabId((cur) => {
        if (cur !== TODO_TAB_ID) return cur;
        const remaining = fileTabs.filter((t) => t.kind !== "todo");
        if (remaining.length === 0) setRightPanelState("closed");
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      });
    } else {
      setFileTabs((prev) => {
        if (prev.some((t) => t.kind === "todo")) return prev;
        return [
          ...prev.filter((t) => t.id !== activeFileTabId),
          { kind: "todo", id: TODO_TAB_ID, label: t("Todos") },
        ];
      });
      setActiveFileTabId(TODO_TAB_ID);
      setRightPanelState("normal");
    }
  }, [fileTabs, activeFileTabId, t]);

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
        onNewSession={handleNewSession}
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
        className={`sidebar-container${sidebarOpen ? "" : " sidebar-closed"}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          width: sidebarOpen ? leftWidth : 0,
          minWidth: sidebarOpen ? leftWidth : 0,
          transition: isDraggingLeft ? "none" : undefined,
        }}
      >
        {sidebarContent}
      </div>

      {/* Drag handle: left ↔ center. Only visible when sidebar is open. */}
      {sidebarOpen && (
        <div
          className={`resize-handle${isDraggingLeft ? " dragging" : ""}`}
          onMouseDown={startDragLeft}
          onDoubleClick={resetLeftWidth}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: rightPanelState === "expanded" ? "none" : "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
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
          {/* Theme preset selector */}
          <div style={{ position: "relative", overflow: "visible" }}>
            <Tooltip content={t("Switch theme")}>
            <button
              onClick={() => {
                setThemeMenuOpen((v) => !v);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 36, height: 36, padding: 0,
                background: "none", border: "none", borderRight: "1px solid var(--border)",
                color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
            </button>
            </Tooltip>
            {themeMenuOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 40 }}
                  onClick={() => setThemeMenuOpen(false)}
                />
                <div
                  style={{
                    position: "absolute", top: "100%", left: 0, zIndex: 50,
                    marginTop: 4, background: "var(--bg-panel)",
                    border: "1px solid var(--border)", borderRadius: 8,
                    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                    minWidth: 120, overflow: "hidden",
                  }}
                >
                  {PRESETS.map((p) => (
                    <button
                      key={p}
                      onClick={(e: React.MouseEvent) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                        setThemeMenuOpen(false);
                        setPreset(p, origin);
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "9px 14px",
                        background: "none", border: "none",
                        color: preset === p ? "var(--accent)" : "var(--text)",
                        cursor: "pointer", fontSize: 13, textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                    >
                      {preset === p && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                      {preset !== p && <span style={{ width: 12 }} />}
                      {PRESET_LABELS[p]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <Tooltip content={t("Switch language")}>
          <button
            onClick={toggleLocale}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
              fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {locale === "zh" ? "EN" : "中"}
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
          {/* Session stats — right-aligned in top bar, hidden when right panel is open */}
          {showChat && (sessionStats || contextUsage) && rightPanelState === "closed" && (() => {
            const t = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
            if (t) {
              tooltipParts.push(`in: ${t.input.toLocaleString()}`);
              tooltipParts.push(`out: ${t.output.toLocaleString()}`);
              tooltipParts.push(`cache read: ${t.cacheRead.toLocaleString()}`);
              tooltipParts.push(`cache write: ${t.cacheWrite.toLocaleString()}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <Tooltip content={tooltip}>
              <div
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: rightPanelState !== "closed" ? 12 : 84,
                  height: "100%",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "default",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {t && t.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                    {fmt(t.input)}
                  </span>
                )}
                {t && t.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {fmt(t.output)}
                  </span>
                )}
                {t && t.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                    {fmt(t.cacheRead)}
                  </span>
                )}
                {costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </div>
              </Tooltip>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              zIndex: 500,
            }}>
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
            </div>
          )}

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
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onAgentsFilesChange={handleAgentsFilesChange}
              scrollToEntryId={pendingScrollEntryId}
              onScrollComplete={() => setPendingScrollEntryId(null)}
              onSessionStatsChange={handleSessionStatsChange}
              onContextUsageChange={handleContextUsageChange}
              onNewSessionRequest={handleSlashNew}
              onSelectSession={handleSelectSession}
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
      {rightPanelState === "normal" && (
        <div
          className={`resize-handle${isDraggingRight ? " dragging" : ""}`}
          onMouseDown={startDragRight}
          onDoubleClick={resetRightWidth}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        className={`right-panel-container right-panel-${rightPanelState}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          width: rightPanelState === "normal" ? rightWidth : undefined,
          minWidth: rightPanelState === "normal" ? rightWidth : undefined,
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
            />
          </div>
        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {activeFileTab?.kind === "todo" ? (
            <TodoPanel />
          ) : activeFileTab?.kind === "file" ? (
            <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              {t("No file open")}
            </div>
          )}
        </div>
      </div>
    </div>
    {/* File panel toggle buttons — fixed at top-right */}
    {/* Expand/collapse — only when panel is open and has tabs */}
    {rightPanelState !== "closed" && fileTabs.length > 0 && (
      <Tooltip content={rightPanelState === "expanded" ? t("Collapse file panel") : t("Expand file panel")}>
      <button
        onClick={() => setRightPanelState((v) => v === "expanded" ? "normal" : "expanded")}
        style={{
          position: "fixed", top: 0, right: 72, zIndex: 300,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, padding: 0,
          background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
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
    {/* Show/hide — always visible */}
    <Tooltip content={activeFileTab?.kind === "todo" ? t("Hide todos") : t("Open todos")}>
    <button
      onClick={handleToggleTodoTab}
      style={{
        position: "fixed", top: 0, right: 36, zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: activeFileTab?.kind === "todo" ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = activeFileTab?.kind === "todo" ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <polyline points="5 8 7 10 11 6" />
      </svg>
    </button>
    </Tooltip>
    <Tooltip content={rightPanelState !== "closed" ? t("Hide file panel") : t("Show file panel")}>
    <button
      onClick={() => setRightPanelState((v) => v === "closed" ? "normal" : "closed")}
      style={{
        position: "fixed", top: 0, right: 0, zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
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
