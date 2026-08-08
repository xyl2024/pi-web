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
 *
 * Layout (post-UI-revamp):
 * - Flat single column of tasks sorted by id ascending (creation order).
 *   No "In progress / Pending / Completed" sections — visual state is the
 *   only status cue: in-progress gets `var(--accent)` text color, completed
 *   gets line-through + `var(--text-dim)`, pending is the default.
 * - The whole header is a `<button>` so the entire row is clickable to
 *   collapse/expand. The header label switches between "Agent Plan" +
 *   `n/m` counter and the in-progress task subject (when collapsed while
 *   an in-progress task exists).
 * - Panel height is capped at 30% of the chat container (`maxHeight: 30%`)
 *   so it never visually competes with the message column. The panel itself
 *   is a `flex column` with `overflow: hidden` and the scroll lives on the
 *   inner task list, so the header stays pinned and visible no matter how
 *   far the list is scrolled. (A `position: sticky` header was rejected: the
 *   panel background is ~50% transparent, so a sticky header would need its
 *   own opaque fill to avoid text-over-text bleed, which would show up as a
 *   color patch on the translucent panel.)
 * - Read-only: no click-to-jump and no tooltip. Tasks are a static
 *   at-a-glance status display; the per-task "<button>" affordance was
 *   removed alongside the tooltip to keep the panel unambiguously passive.
 */

import { memo, useCallback, useMemo, useState } from "react";
import type { AgentTask } from "@/lib/agent-todo-tool-types";
import { useAgentTodo } from "@/hooks/useAgentTodo";
import { useI18n } from "@/hooks/useI18n";

const PANEL_BREAKPOINT = 1100;

interface TaskRowProps {
  task: AgentTask;
  /** Whether this is the last task in the list — suppresses trailing divider. */
  isLast: boolean;
}

const TaskRow = memo(function TaskRow({ task, isLast }: TaskRowProps) {
  const isInProgress = task.status === "in_progress";
  const isCompleted = task.status === "completed";
  const subjectColor = isCompleted
    ? "var(--text-dim)"
    : isInProgress
      ? "var(--accent)"
      : "var(--text)";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        width: "100%",
        padding: "6px 8px",
        border: "none",
        borderBottom: isLast ? "none" : "1px solid var(--border)",
        background: "transparent",
        color: "var(--text)",
      }}
    >
      <span
        style={{
          fontSize: 13,
          lineHeight: 1.4,
          textDecoration: isCompleted ? "line-through" : "none",
          color: subjectColor,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {task.subject}
      </span>
      {isInProgress && task.activeForm ? (
        <span
          style={{
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
    </div>
  );
});

export const AgentTodoPanel = memo(function AgentTodoPanel({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { tasks, empty, counts, enabled } = useAgentTodo(sessionId);
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  const handleToggle = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  // Flat id-ascending list — visual state is the only status cue.
  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => a.id - b.id),
    [tasks],
  );
  const firstInProgress = sortedTasks.find((t) => t.status === "in_progress");

  // Header label logic:
  // - Collapsed + ≥1 in-progress task → show the in-progress subject as the
  //   header (replaces both title and counter for the most informative summary).
  // - Otherwise → title + counter.
  const showCollapsedSubject = collapsed && !!firstInProgress;
  const headerLabel = showCollapsedSubject ? firstInProgress!.subject : t("Agent Plan");

  if (!enabled || empty) return null;

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
          // Background is ~50% transparent + backdrop blur: when the panel
          // overlaps the message column on narrower viewports, the text
          // behind shows through softly instead of being fully occluded.
          // The panel's own text/colors stay fully opaque — only the
          // backdrop fades.
          //
          // maxHeight: 30% — caps the panel at 30% of the chat container's
          // height so it never visually competes with the message column.
          // The chat container is `flex flex-1 overflow-hidden`, so its
          // height is well-defined and percentage resolution works.
          //
          // The panel clips rather than scrolls (`overflow: hidden`); the
          // scrollport is the inner task list, which keeps the header row
          // pinned at the top of the panel.
          position: "absolute",
          left: 16,
          top: 16,
          width: 256,
          maxHeight: "30%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          padding: "10px 6px",
          background: "color-mix(in srgb, var(--bg-panel) 50%, transparent)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
          zIndex: 10,
          fontFamily: "var(--font-sans)",
          animation: "agent-todo-fade-in 200ms ease",
        }}
      >
        <button
          type="button"
          onClick={handleToggle}
          aria-label={collapsed ? t("Expand") : t("Collapse")}
          aria-expanded={!collapsed}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            width: "100%",
            // Never let the flex container squeeze the header when the task
            // list overflows — the list is the only thing allowed to shrink.
            flexShrink: 0,
            padding: collapsed ? "0 8px" : "0 8px 8px",
            background: "transparent",
            border: "none",
            borderBottom: collapsed ? "none" : "1px solid var(--border)",
            borderRadius: 3,
            marginBottom: collapsed ? 0 : 8,
            cursor: "pointer",
            color: "var(--text)",
            textAlign: "left",
            fontFamily: "inherit",
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: 1,
            }}
          >
            {headerLabel}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {!showCollapsedSubject && (
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {counts.completed}/{counts.total}
              </span>
            )}
            <svg
              width="10"
              height="10"
              viewBox="0 0 12 12"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden
              style={{ color: "var(--text-muted)" }}
            >
              {collapsed ? (
                <path d="M3 7.5L6 4.5L9 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </span>
        </button>
        {!collapsed && (
          // minHeight: 0 lets this flex item shrink below its content height
          // so `overflowY: auto` actually engages instead of overflowing the
          // panel's maxHeight.
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            {sortedTasks.map((task, idx) => (
              <TaskRow
                key={task.id}
                task={task}
                isLast={idx === sortedTasks.length - 1}
              />
            ))}
          </div>
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
