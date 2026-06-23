"use client";

/**
 * AgentTodoPanel — a floating panel in the chat container's left whitespace,
 * vertically centered, that surfaces the agent's live task plan.
 *
 * Position strategy:
 * - Rendered as a sibling of the chat scroll container (inside the same
 *   `position: relative` parent) with `position: absolute`. It is NOT a
 *   flex item, so it does not consume horizontal space — the centered
 *   message column (max-w 820) keeps its natural centered position.
 * - Top-aligned with a small gap from the chat area's upper edge
 *   (`top: 16`), so the panel sits near the top of the chat area (just
 *   below the topbar) rather than floating in the vertical center.
 * - Hidden when there's nothing to render (no empty placeholder) and below
 *   the 1100px responsive threshold (no room for the panel next to messages).
 */

import { memo, useCallback, useMemo, useState } from "react";
import type { AgentTask } from "@/lib/agent-todo-tool-types";
import { useAgentTodo } from "@/hooks/useAgentTodo";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";
import { Tooltip } from "@/components/Tooltip";

const PANEL_BREAKPOINT = 1100;

interface TaskRowProps {
  task: AgentTask;
  /**
   * Map of taskId → toolCallId for tasks whose "mark completed" call is
   * visible in the current chat. Clicking a completed row jumps to the
   * matching tool call when present; otherwise shows a toast.
   */
  taskToolCallIds: Record<number, string>;
  /** Scroll-to handler — invoked with a toolCallId. */
  onJumpToTask: (toolCallId: string) => void;
  /** Toast for the "no scroll target" fallback messages. */
  onNotify: (message: string) => void;
  /** i18n key prefix — "Jump to completion" appended for completed rows. */
  tTitleSuffix: string;
  /** i18n message shown when the row has no scroll target. */
  tNotInBranch: string;
  /** i18n message shown when the task is not yet completed. */
  tNotCompleted: string;
}

const TaskRow = memo(function TaskRow({
  task,
  taskToolCallIds,
  onJumpToTask,
  onNotify,
  tTitleSuffix,
  tNotInBranch,
  tNotCompleted,
}: TaskRowProps) {
  const isInProgress = task.status === "in_progress";
  const isCompleted = task.status === "completed";
  const toolCallId = isCompleted ? taskToolCallIds[task.id] : undefined;
  const jumpable = !!toolCallId;

  const handleClick = useCallback(() => {
    if (jumpable && toolCallId) {
      onJumpToTask(toolCallId);
      return;
    }
    if (isCompleted) {
      // Completed, but the matching tool call isn't visible in the current
      // chat (e.g. user navigated to a different branch). Surface the reason
      // instead of silently doing nothing.
      onNotify(tNotInBranch);
      return;
    }
    onNotify(tNotCompleted);
  }, [jumpable, toolCallId, isCompleted, onJumpToTask, onNotify, tNotInBranch, tNotCompleted]);

  const tooltipContent = jumpable ? `${tTitleSuffix} · #${task.id}` : `#${task.id}`;

  return (
    <Tooltip content={tooltipContent}>
      <button
        type="button"
        onClick={handleClick}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          width: "100%",
          padding: "6px 8px",
          borderRadius: 4,
          border: "none",
          background: "transparent",
          textAlign: "left",
          cursor: "pointer",
          color: "var(--text)",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        }}
      >
      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          #{task.id}
        </span>
        <span
          style={{
            fontSize: 13,
            lineHeight: 1.4,
            textDecoration: isCompleted ? "line-through" : "none",
            color: isCompleted ? "var(--text-dim)" : "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {task.subject}
        </span>
      </span>
      {isInProgress && task.activeForm ? (
        <span
          style={{
            marginLeft: 22,
            fontSize: 11,
            color: "var(--text-muted)",
            fontStyle: "italic",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.activeForm}
        </span>
      ) : null}
      </button>
    </Tooltip>
  );
});

interface GroupProps {
  label: string;
  tasks: AgentTask[];
  taskToolCallIds: Record<number, string>;
  onJumpToTask: (toolCallId: string) => void;
  onNotify: (message: string) => void;
  tTitleSuffix: string;
  tNotInBranch: string;
  tNotCompleted: string;
}

const Group = memo(function Group({
  label,
  tasks,
  taskToolCallIds,
  onJumpToTask,
  onNotify,
  tTitleSuffix,
  tNotInBranch,
  tNotCompleted,
}: GroupProps) {
  if (tasks.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          padding: "4px 8px",
        }}
      >
        {label} · {tasks.length}
      </div>
      <div>
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            taskToolCallIds={taskToolCallIds}
            onJumpToTask={onJumpToTask}
            onNotify={onNotify}
            tTitleSuffix={tTitleSuffix}
            tNotInBranch={tNotInBranch}
            tNotCompleted={tNotCompleted}
          />
        ))}
      </div>
    </div>
  );
});

export const AgentTodoPanel = memo(function AgentTodoPanel({
  sessionId,
  taskToolCallIds,
  onJumpToTask,
}: {
  sessionId: string | null;
  /** taskId → toolCallId for completed tasks; missing entries are not jumpable. */
  taskToolCallIds?: Record<number, string>;
  /** Scroll handler invoked when a completed task is clicked. */
  onJumpToTask?: (toolCallId: string) => void;
}) {
  const { tasks, empty, counts } = useAgentTodo(sessionId);
  const { t } = useI18n();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);

  // Bound versions of the new props — keeps Group / TaskRow simple and lets
  // us pass undefined-safe defaults without sprinkling ?-chains at every call.
  const emptyTaskToolCallIds: Record<number, string> = {};
  const boundTaskToolCallIds = taskToolCallIds ?? emptyTaskToolCallIds;
  const boundOnJumpToTask = useCallback(
    (toolCallId: string) => onJumpToTask?.(toolCallId),
    [onJumpToTask],
  );
  const handleNotify = useCallback(
    (message: string) => {
      toast.show({ kind: "info", message });
    },
    [toast],
  );
  const tTitleSuffix = t("Jump to completion");
  const tNotInBranch = t("Completion not in current branch");
  const tNotCompleted = t("Not completed yet");

  const handleToggle = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  const groups = useMemo(() => {
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    const pending = tasks.filter((t) => t.status === "pending");
    const completed = tasks.filter((t) => t.status === "completed");
    return { inProgress, pending, completed };
  }, [tasks]);

  if (empty) return null;

  return (
    <>
      <style>{`
        @media (max-width: ${PANEL_BREAKPOINT - 1}px) {
          .agent-todo-panel { display: none !important; }
        }
      `}</style>
      <aside
        className="agent-todo-panel"
        aria-label={t("Agent Plan")}
        style={{
          // Absolute floating panel in the chat area's left whitespace.
          // Anchored to the chat container (parent is `position: relative`)
          // so it does not occupy flex space and does not squeeze the
          // centered message column. Top-aligned with a small gap from the
          // chat area's upper edge (not flush with the topbar).
          //
          // Background is ~12% transparent + backdrop blur: when the panel
          // overlaps the message column on narrower viewports, the text
          // behind shows through softly instead of being fully occluded.
          // The panel's own text/colors stay fully opaque — only the
          // backdrop fades.
          position: "absolute",
          left: 16,
          top: 16,
          width: 256,
          maxHeight: "60vh",
          padding: "10px 6px",
          background: "color-mix(in srgb, var(--bg-panel) 50%, transparent)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
          overflowY: "auto",
          zIndex: 10,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          animation: "agent-todo-fade-in 200ms ease",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: collapsed ? "0 8px" : "0 8px 8px",
            borderBottom: collapsed ? "none" : "1px solid var(--border)",
            marginBottom: collapsed ? 0 : 8,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
            {t("Agent Plan")}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {counts.completed}/{counts.total}
              {counts.inProgress > 0 ? ` ◐${counts.inProgress}` : ""}
              {counts.pending > 0 ? ` ○${counts.pending}` : ""}
            </span>
            <button
              type="button"
              onClick={handleToggle}
              aria-label={collapsed ? t("Expand") : t("Collapse")}
              aria-expanded={!collapsed}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                padding: 0,
                background: "transparent",
                border: "none",
                borderRadius: 3,
                cursor: "pointer",
                color: "var(--text-muted)",
                transition: "color 120ms, background 120ms",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              {collapsed ? (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
                  <path d="M3 7.5L6 4.5L9 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
                  <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </span>
        </div>
        {!collapsed && (
          <>
            <Group
              label={t("In progress")}
              tasks={groups.inProgress}
              taskToolCallIds={boundTaskToolCallIds}
              onJumpToTask={boundOnJumpToTask}
              onNotify={handleNotify}
              tTitleSuffix={tTitleSuffix}
              tNotInBranch={tNotInBranch}
              tNotCompleted={tNotCompleted}
            />
            <Group
              label={t("Pending")}
              tasks={groups.pending}
              taskToolCallIds={boundTaskToolCallIds}
              onJumpToTask={boundOnJumpToTask}
              onNotify={handleNotify}
              tTitleSuffix={tTitleSuffix}
              tNotInBranch={tNotInBranch}
              tNotCompleted={tNotCompleted}
            />
            <Group
              label={t("Completed")}
              tasks={groups.completed}
              taskToolCallIds={boundTaskToolCallIds}
              onJumpToTask={boundOnJumpToTask}
              onNotify={handleNotify}
              tTitleSuffix={tTitleSuffix}
              tNotInBranch={tNotInBranch}
              tNotCompleted={tNotCompleted}
            />
          </>
        )}
      </aside>
      <style>{`
        @keyframes agent-todo-fade-in {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
});
