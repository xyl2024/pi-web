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

import { memo, useCallback, useMemo } from "react";
import type { AgentTask } from "@/lib/agent-todo-tool-types";
import { useAgentTodo } from "@/hooks/useAgentTodo";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";

const PANEL_BREAKPOINT = 1100;

interface TaskRowProps {
  task: AgentTask;
  onCopy: (id: number) => void;
}

const TaskRow = memo(function TaskRow({ task, onCopy }: TaskRowProps) {
  const isInProgress = task.status === "in_progress";
  const isCompleted = task.status === "completed";

  const handleClick = useCallback(() => {
    onCopy(task.id);
  }, [onCopy, task.id]);

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`#${task.id}`}
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
          aria-hidden
          style={{
            display: "inline-block",
            width: 14,
            color: isInProgress
              ? "var(--accent)"
              : isCompleted
                ? "var(--text-dim)"
                : "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {isCompleted ? "✓" : isInProgress ? "◐" : "○"}
        </span>
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
  );
});

interface GroupProps {
  label: string;
  tasks: AgentTask[];
  onCopy: (id: number) => void;
}

const Group = memo(function Group({ label, tasks, onCopy }: GroupProps) {
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
          <TaskRow key={t.id} task={t} onCopy={onCopy} />
        ))}
      </div>
    </div>
  );
});

export const AgentTodoPanel = memo(function AgentTodoPanel({ sessionId }: { sessionId: string | null }) {
  const { tasks, empty, counts } = useAgentTodo(sessionId);
  const { t } = useI18n();
  const toast = useToast();

  const handleCopy = useCallback(
    (id: number) => {
      const text = `#${id}`;
      const write = navigator.clipboard?.writeText(text);
      if (write && typeof write.then === "function") {
        write.then(
          () => toast.show({ kind: "success", message: `${t("Copied")} ${text}` }),
          () => toast.show({ kind: "error", message: t("Copied") + " failed" }),
        );
      }
    },
    [t, toast],
  );

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
          position: "absolute",
          left: 16,
          top: 16,
          width: 256,
          maxHeight: "60vh",
          padding: "10px 6px",
          background: "var(--bg-panel)",
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
            padding: "0 8px 8px",
            borderBottom: "1px solid var(--border)",
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
            {t("Agent Plan")}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {counts.completed}/{counts.total}
            {counts.inProgress > 0 ? ` ◐${counts.inProgress}` : ""}
            {counts.pending > 0 ? ` ○${counts.pending}` : ""}
          </span>
        </div>
        <Group label={t("In progress")} tasks={groups.inProgress} onCopy={handleCopy} />
        <Group label={t("Pending")} tasks={groups.pending} onCopy={handleCopy} />
        <Group label={t("Completed")} tasks={groups.completed} onCopy={handleCopy} />
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