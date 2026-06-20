"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

type TaskRunStatus = "running" | "success" | "error" | "timeout";

interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  cwd: string;
  prompt: string;
  enabled: boolean;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  toolNames: string[] | null;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastRunStatus: TaskRunStatus | null;
  unreadCount: number;
}

interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt: number | null;
  status: TaskRunStatus;
  replyText: string | null;
  error: string | null;
  sessionId: string | null;
  durationMs: number | null;
  readAt: number | null;
}

interface Props {
  onOpenSession?: (sessionId: string) => void;
}

const EMPTY_FORM = {
  name: "",
  cron: "",
  cwd: "",
  prompt: "",
  enabled: true,
  provider: "",
  modelId: "",
  thinkingLevel: "",
  toolNames: "",
};

function formatDateTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function statusColor(status: TaskRunStatus | null): string {
  switch (status) {
    case "success": return "#4ade80";
    case "running": return "var(--accent)";
    case "error": return "#f87171";
    case "timeout": return "#fbbf24";
    default: return "var(--text-dim)";
  }
}

function statusSymbol(status: TaskRunStatus | null): string {
  switch (status) {
    case "success": return "✓";
    case "running": return "●";
    case "error": return "✗";
    case "timeout": return "⏱";
    default: return "·";
  }
}

export function SchedulerPanel({ onOpenSession }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runsModalTaskId, setRunsModalTaskId] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/scheduled-tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tasks?: ScheduledTask[] };
      setTasks(data.tasks ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (taskId: string) => {
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { runs?: TaskRun[] };
      setRuns(data.runs ?? []);
    } catch {
      toast.show({ kind: "error", message: t("Failed to load runs") });
    } finally {
      setRunsLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    if (open) void loadTasks();
  }, [open, loadTasks]);

  useEffect(() => {
    if (runsModalTaskId) void loadRuns(runsModalTaskId);
  }, [runsModalTaskId, loadRuns]);

  // Auto-refresh runs while a run is in flight.
  useEffect(() => {
    const inFlight = runs.some((r) => r.status === "running");
    if (!runsModalTaskId || !inFlight) return;
    const timer = setInterval(() => { void loadRuns(runsModalTaskId); }, 2000);
    return () => clearInterval(timer);
  }, [runsModalTaskId, runs, loadRuns]);

  const runsModalTask = tasks.find((t) => t.id === runsModalTaskId) ?? null;

  const openNewForm = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormOpen(true);
  };

  const openEditForm = (task: ScheduledTask) => {
    setEditingId(task.id);
    setForm({
      name: task.name,
      cron: task.cron,
      cwd: task.cwd,
      prompt: task.prompt,
      enabled: task.enabled,
      provider: task.provider ?? "",
      modelId: task.modelId ?? "",
      thinkingLevel: task.thinkingLevel ?? "",
      toolNames: (task.toolNames ?? []).join(", "),
    });
    setFormOpen(true);
  };

  const cancelForm = () => {
    setFormOpen(false);
    setEditingId(null);
  };

  const saveForm = async () => {
    if (saving) return;
    setSaving(true);
    const toolNamesArr = form.toolNames
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const body = {
      name: form.name.trim(),
      cron: form.cron.trim(),
      cwd: form.cwd.trim(),
      prompt: form.prompt.trim(),
      enabled: form.enabled,
      provider: form.provider.trim() || null,
      modelId: form.modelId.trim() || null,
      thinkingLevel: form.thinkingLevel.trim() || null,
      toolNames: toolNamesArr.length > 0 ? toolNamesArr : null,
    };
    try {
      let res: Response;
      if (editingId) {
        res = await fetch("/api/scheduled-tasks", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingId, ...body }),
        });
      } else {
        res = await fetch("/api/scheduled-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.show({ kind: "success", message: editingId ? t("Task updated") : t("Task created") });
      setFormOpen(false);
      setEditingId(null);
      void loadTasks();
    } catch (e) {
      toast.show({
        kind: "error",
        message: editingId ? t("Failed to update task") + ": " + String(e) : t("Failed to create task") + ": " + String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (task: ScheduledTask) => {
    try {
      const res = await fetch("/api/scheduled-tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, enabled: !task.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void loadTasks();
    } catch (e) {
      toast.show({ kind: "error", message: t("Failed to update task") + ": " + String(e) });
    }
  };

  const markAllRead = async (taskId: string) => {
    try {
      const res = await fetch(
        `/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/mark-all-read`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void loadRuns(taskId);
      void loadTasks();
    } catch (e) {
      toast.show({ kind: "error", message: t("Failed to update runs") + ": " + String(e) });
    }
  };

  const toggleRunRead = async (run: TaskRun) => {
    const nextRead = run.readAt === null;
    // Optimistic update
    setRuns((prev) => prev.map((r) => (r.id === run.id ? { ...r, readAt: nextRead ? Date.now() : null } : r)));
    try {
      const res = await fetch(
        `/api/scheduled-tasks/runs/${encodeURIComponent(run.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: nextRead }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void loadTasks();
    } catch (e) {
      // Revert on failure
      setRuns((prev) => prev.map((r) => (r.id === run.id ? { ...r, readAt: run.readAt } : r)));
      toast.show({ kind: "error", message: t("Failed to update run") + ": " + String(e) });
    }
  };

  const deleteTask = async (id: string) => {
    try {
      const res = await fetch(`/api/scheduled-tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.show({ kind: "success", message: t("Task deleted") });
      setConfirmDeleteId(null);
      if (runsModalTaskId === id) {
        setRunsModalTaskId(null);
        setRuns([]);
      }
      void loadTasks();
    } catch (e) {
      toast.show({ kind: "error", message: t("Failed to delete task") + ": " + String(e) });
    }
  };

  const triggerNow = async (task: ScheduledTask) => {
    if (triggering) return;
    setTriggering(task.id);
    try {
      const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.show({ kind: "success", message: t("Task triggered") });
      setRunsModalTaskId(task.id);
      void loadRuns(task.id);
    } catch (e) {
      toast.show({ kind: "error", message: t("Failed to trigger task") + ": " + String(e) });
    } finally {
      setTriggering(null);
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
          padding: "8px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          textAlign: "left",
        }}
      >
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
        >
          <polyline points="3 2 7 5 3 8" />
        </svg>
        {t("Scheduled tasks")}
        {tasks.length > 0 && (
          <span style={{ color: "var(--text-dim)", fontWeight: 400, textTransform: "none" }}>
            ({tasks.length})
          </span>
        )}
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", maxHeight: 380, overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 6, padding: "4px 10px 8px", flexShrink: 0 }}>
            <button
              onClick={openNewForm}
              style={{
                flex: 1,
                padding: "4px 8px",
                background: "var(--accent)",
                border: "none",
                borderRadius: 5,
                color: "#fff",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + {t("New task")}
            </button>
            <Tooltip content={t("Refresh")}>
              <button
                onClick={() => void loadTasks()}
                aria-label={t("Refresh")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26, height: 26, padding: 0,
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            </Tooltip>
          </div>

          {/* Task list */}
          <div style={{ overflowY: "auto", maxHeight: 180, borderTop: "1px solid var(--border)" }}>
            {loading && (
              <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 11 }}>{t("Loading...")}</div>
            )}
            {error && (
              <div style={{ padding: "10px 12px", color: "#f87171", fontSize: 11 }}>{error}</div>
            )}
            {!loading && !error && tasks.length === 0 && (
              <div style={{ padding: "12px", color: "var(--text-dim)", fontSize: 11, textAlign: "center" }}>
                {t("No scheduled tasks yet")}
              </div>
            )}
            {tasks.map((task) => (
              <div
                key={task.id}
                onClick={() => setRunsModalTaskId(task.id)}
                title={t("View runs")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 10px",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--border)",
                  background: "transparent",
                  opacity: task.enabled ? 1 : 0.55,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    width: 12,
                    color: statusColor(task.lastRunStatus),
                    flexShrink: 0,
                    fontSize: 11,
                    textAlign: "center",
                  }}
                  title={task.lastRunStatus ?? ""}
                >
                  {statusSymbol(task.lastRunStatus)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: task.unreadCount > 0 ? 600 : 400,
                      }}
                    >
                      {task.name}
                    </span>
                    {task.unreadCount > 0 && (
                      <span
                        aria-label={`${task.unreadCount} ${t("unread")}`}
                        title={`${task.unreadCount} ${t("unread")}`}
                        style={{
                          flexShrink: 0,
                          background: "#ef4444",
                          color: "#fff",
                          fontSize: 9,
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: 9,
                          lineHeight: 1.4,
                          minWidth: 16,
                          textAlign: "center",
                        }}
                      >
                        {task.unreadCount > 99 ? "99+" : task.unreadCount}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={`${task.cron} — next: ${formatDateTime(task.nextRunAt)}`}
                  >
                    {task.cron} · {task.enabled ? `${t("Next run")} ${formatDateTime(task.nextRunAt)}` : t("disabled")}
                  </div>
                </div>
                <span
                  onClick={(e) => { e.stopPropagation(); void toggleEnabled(task); }}
                  title={task.enabled ? t("Disable") : t("Enable")}
                  aria-label={task.enabled ? t("Disable") : t("Enable")}
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: task.enabled ? "#4ade80" : "#f87171",
                    flexShrink: 0,
                    cursor: "pointer",
                    boxShadow: task.enabled ? "0 0 4px rgba(74, 222, 128, 0.6)" : "0 0 4px rgba(248, 113, 113, 0.6)",
                  }}
                />
              </div>
            ))}
          </div>

          {/* Selected task: runs history (moved to modal) */}
        </div>
      )}

      {/* Runs history modal */}
      {runsModalTask && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) { setRunsModalTaskId(null); setRuns([]); } }}
          style={{
            position: "fixed", inset: 0, zIndex: 1100,
            background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 16,
              width: 560,
              maxWidth: "94vw",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t("Runs history")}: {runsModalTask.name}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                  {runsModalTask.cron} · {runsModalTask.enabled ? `${t("Next run")} ${formatDateTime(runsModalTask.nextRunAt)}` : t("disabled")}
                </div>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}>
                  <input
                    type="checkbox"
                    checked={runsModalTask.enabled}
                    onChange={() => void toggleEnabled(runsModalTask)}
                  />
                  {runsModalTask.enabled ? t("enabled") : t("disabled")}
                </label>
                {runs.some((r) => r.readAt === null) && (
                  <button
                    onClick={() => void markAllRead(runsModalTask.id)}
                    style={{
                      display: "inline-block",
                      marginTop: 6,
                      marginLeft: 12,
                      padding: "2px 8px",
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      fontSize: 10,
                      cursor: "pointer",
                    }}
                  >
                    {t("Mark all as read")}
                  </button>
                )}
              </div>
              <Tooltip content={t("Run now")}>
                <button
                  onClick={() => void triggerNow(runsModalTask)}
                  disabled={triggering === runsModalTask.id}
                  aria-label={t("Run now")}
                  style={{
                    padding: "4px 10px",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text-muted)",
                    fontSize: 11,
                    cursor: triggering === runsModalTask.id ? "default" : "pointer",
                    opacity: triggering === runsModalTask.id ? 0.6 : 1,
                  }}
                >
                  {triggering === runsModalTask.id ? t("Triggering...") : t("Run now")}
                </button>
              </Tooltip>
              <Tooltip content={t("Edit task")}>
                <button
                  onClick={() => { openEditForm(runsModalTask); setRunsModalTaskId(null); setRuns([]); }}
                  aria-label={t("Edit task")}
                  style={{
                    width: 26, height: 26, padding: 0,
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip content={t("Delete task")}>
                <button
                  onClick={() => setConfirmDeleteId(runsModalTask.id)}
                  aria-label={t("Delete task")}
                  style={{
                    width: 26, height: 26, padding: 0,
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "#ef4444",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip content={t("Close")}>
                <button
                  onClick={() => { setRunsModalTaskId(null); setRuns([]); }}
                  aria-label={t("Close")}
                  style={{
                    width: 26, height: 26, padding: 0,
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </Tooltip>
            </div>

            <div style={{ overflowY: "auto", flex: 1, borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
              {runsLoading && runs.length === 0 && (
                <div style={{ padding: "14px", color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>{t("Loading...")}</div>
              )}
              {!runsLoading && runs.length === 0 && (
                <div style={{ padding: "20px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
                  {t("No runs yet")}
                </div>
              )}
              {runs.map((run) => {
                const isUnread = run.readAt === null;
                return (
                <div
                  key={run.id}
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 12,
                    background: isUnread ? "rgba(37,99,235,0.04)" : "transparent",
                    borderLeft: isUnread ? "2px solid var(--accent)" : "2px solid transparent",
                    paddingLeft: isUnread ? 8 : 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: statusColor(run.status), flexShrink: 0, fontSize: 12 }}>{statusSymbol(run.status)}</span>
                    <span style={{ color: "var(--text-muted)", flex: 1, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      {formatDateTime(run.startedAt)}
                    </span>
                    {run.durationMs != null && (
                      <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                        {(run.durationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                    <Tooltip content={isUnread ? t("Mark as read") : t("Mark as unread")}>
                      <button
                        onClick={() => void toggleRunRead(run)}
                        aria-label={isUnread ? t("Mark as read") : t("Mark as unread")}
                        style={{
                          padding: "2px 6px",
                          background: "none",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          color: isUnread ? "var(--accent)" : "var(--text-dim)",
                          fontSize: 10,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {isUnread ? "●" : "○"}
                      </button>
                    </Tooltip>
                    {run.sessionId && onOpenSession && (
                      <Tooltip content={t("Open session")}>
                        <button
                          onClick={() => { onOpenSession(run.sessionId!); setRunsModalTaskId(null); setRuns([]); }}
                          aria-label={t("Open session")}
                          style={{
                            padding: "2px 8px",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            color: "var(--text-muted)",
                            fontSize: 10,
                            cursor: "pointer",
                          }}
                        >
                          ↗
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Form modal */}
      {formOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) cancelForm(); }}
          style={{
            position: "fixed", inset: 0, zIndex: 1100,
            background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 16,
              width: 440,
              maxWidth: "92vw",
              maxHeight: "85vh",
              overflowY: "auto",
              boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
              {editingId ? t("Edit task") : t("New task")}
            </div>

            <Field label={t("Task name")}>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
            </Field>
            <Field label={t("Cron expression")} hint={t("Cron examples hint")}>
              <input
                value={form.cron}
                onChange={(e) => setForm({ ...form, cron: e.target.value })}
                placeholder="0 9 * * *"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <Field label={t("Working directory")}>
              <input
                value={form.cwd}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                placeholder="/path/to/project"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <Field label={t("Prompt")}>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                rows={4}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)" }}
              />
            </Field>

            <details style={{ color: "var(--text-muted)", fontSize: 11 }}>
              <summary style={{ cursor: "pointer", userSelect: "none" }}>{t("Provider (optional)")}</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
                <Field label={t("Provider (optional)")}>
                  <input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder={t("Default model")} style={inputStyle} />
                </Field>
                <Field label={t("Model (optional)")}>
                  <input value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} style={inputStyle} />
                </Field>
                <Field label={t("Thinking level (optional)")}>
                  <input value={form.thinkingLevel} onChange={(e) => setForm({ ...form, thinkingLevel: e.target.value })} style={inputStyle} />
                </Field>
                <Field label={t("Tool names (optional, comma-separated)")}>
                  <input value={form.toolNames} onChange={(e) => setForm({ ...form, toolNames: e.target.value })} style={inputStyle} />
                </Field>
              </div>
            </details>

            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              {t("enabled")}
            </label>

            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                onClick={() => void saveForm()}
                disabled={saving}
                style={{
                  flex: 1, padding: "6px 0",
                  background: "var(--accent)", border: "none", borderRadius: 6,
                  color: "#fff", fontSize: 12, fontWeight: 600,
                  cursor: saving ? "default" : "pointer",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {t("Save")}
              </button>
              <button
                onClick={cancelForm}
                disabled={saving}
                style={{
                  flex: 1, padding: "6px 0",
                  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
                  color: "var(--text-muted)", fontSize: 12,
                  cursor: saving ? "default" : "pointer",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDeleteId && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}
          style={{
            position: "fixed", inset: 0, zIndex: 1100,
            background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 16,
              width: 320,
              maxWidth: "92vw",
              boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 12 }}>
              {t("Delete task?")}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void deleteTask(confirmDeleteId)}
                style={{
                  flex: 1, padding: "6px 0",
                  background: "#ef4444", border: "none", borderRadius: 6,
                  color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >
                {t("Delete")}
              </button>
              <button
                onClick={() => setConfirmDeleteId(null)}
                style={{
                  flex: 1, padding: "6px 0",
                  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
                  color: "var(--text-muted)", fontSize: 12, cursor: "pointer",
                }}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 12,
  padding: "5px 8px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  outline: "none",
  background: "var(--bg)",
  color: "var(--text)",
  boxSizing: "border-box",
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}