"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Tooltip } from "@/components/Tooltip";
import { useI18n, type Locale } from "@/hooks/useI18n";
import type { Todo } from "@/hooks/useTodos";

export type CalendarMonth = {
  year: number;
  month: number;
};

type CalendarCell = {
  ts: number;
  day: number;
  isCurrentMonth: boolean;
};

interface TodoMonthCalendarProps {
  todos: Todo[];
  month: CalendarMonth;
  today: number;
  selectedDay: number | null;
  locale: Locale;
  onMonthChange: (month: CalendarMonth) => void;
  onSelectDay: (ts: number) => void;
}

function startOfLocalDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dateKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isSameDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

function addMonths(month: CalendarMonth, delta: number): CalendarMonth {
  const date = new Date(month.year, month.month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

function buildCells(year: number, month: number): CalendarCell[] {
  const firstOfMonth = new Date(year, month, 1);
  // Date#getDay(): Sunday=0. Shift so Monday is column zero.
  const leading = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: CalendarCell[] = [];

  for (let offset = leading; offset > 0; offset -= 1) {
    const date = new Date(year, month, 1 - offset);
    cells.push({ ts: startOfLocalDay(date.getTime()), day: date.getDate(), isCurrentMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    cells.push({ ts: startOfLocalDay(date.getTime()), day, isCurrentMonth: true });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    const date = new Date(year, month + 1, nextDay);
    cells.push({ ts: startOfLocalDay(date.getTime()), day: date.getDate(), isCurrentMonth: false });
    nextDay += 1;
  }
  return cells;
}

function heatmapBackground(count: number, maxCount: number): string | undefined {
  if (count === 0 || maxCount === 0) return undefined;
  const ratio = count / maxCount;
  const opacity = Math.round(12 + ratio * 58);
  return `color-mix(in srgb, var(--accent) ${opacity}%, transparent)`;
}

// Mirrored from PRIORITY_PALETTE in components/TodoPanel.tsx — kept narrow
// here so the tooltip doesn't pull the entire TodoPanel into a separate
// import surface (and to keep this file self-contained).
const CALENDAR_PRIORITY_DOT: Record<NonNullable<Todo["priority"]>, { bg: string; glyph: string }> = {
  high:   { bg: "#ef4444", glyph: "!" },
  medium: { bg: "#f97316", glyph: "=" },
  low:    { bg: "#3b82f6", glyph: "↓" },
};

function DayTooltipContent({ todos, t }: { todos: Todo[]; t: (key: string) => string }): ReactNode {
  return (
    <div style={{ maxHeight: "min(60vh, 240px)", overflowY: "auto", minWidth: 160 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {t("{n} todos").replace("{n}", String(todos.length))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {todos.map((todo) => (
          <div
            key={todo.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              textDecoration: todo.done ? "line-through" : "none",
              opacity: todo.done ? 0.5 : 1,
              wordBreak: "break-word",
            }}
          >
            {todo.priority && (
              <span
                aria-hidden
                title={todo.priority}
                style={{
                  flexShrink: 0,
                  marginTop: 2,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: CALENDAR_PRIORITY_DOT[todo.priority].bg,
                  color: "#ffffff",
                  fontSize: 7,
                  fontWeight: 700,
                  lineHeight: 1,
                }}
              >
                {CALENDAR_PRIORITY_DOT[todo.priority].glyph}
              </span>
            )}
            <span
              style={{
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 2,
                overflow: "hidden",
              }}
            >
              {todo.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DayCell({
  cell,
  todos,
  maxCount,
  today,
  selectedDay,
  isTouchDevice,
  onSelectDay,
  t,
}: {
  cell: CalendarCell;
  todos: Todo[];
  maxCount: number;
  today: number;
  selectedDay: number | null;
  isTouchDevice: boolean;
  onSelectDay: (ts: number) => void;
  t: (key: string) => string;
}) {
  const [mobileTooltipOpen, setMobileTooltipOpen] = useState(false);
  const count = todos.length;
  const selected = cell.isCurrentMonth && selectedDay === cell.ts;
  const todayCell = cell.isCurrentMonth && isSameDay(cell.ts, today);

  useEffect(() => {
    if (!selected) setMobileTooltipOpen(false);
  }, [selected]);

  const handleClick = () => {
    if (!cell.isCurrentMonth || count === 0) return;
    if (isTouchDevice) setMobileTooltipOpen((open) => !open);
    onSelectDay(cell.ts);
  };

  const content = count > 0 ? <DayTooltipContent todos={todos} t={t} /> : null;
  const background = heatmapBackground(count, maxCount);

  return (
    <Tooltip
      content={content}
      delayDuration={isTouchDevice ? 0 : undefined}
      open={isTouchDevice ? mobileTooltipOpen : count > 0 ? undefined : false}
      onOpenChange={isTouchDevice ? setMobileTooltipOpen : undefined}
    >
      <button
        type="button"
        onClick={handleClick}
        disabled={!cell.isCurrentMonth || count === 0}
        aria-label={`${cell.day}${count > 0 ? `, ${t("{n} todos").replace("{n}", String(count))}` : ""}`}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 34,
          padding: "4px 2px",
          border: 0,
          borderRadius: 5,
          background: background ?? "transparent",
          color: cell.isCurrentMonth ? "var(--text)" : "var(--text-dim)",
          opacity: cell.isCurrentMonth ? 1 : 0.42,
          boxShadow: todayCell ? "inset 0 0 0 1px var(--accent)" : undefined,
          cursor: cell.isCurrentMonth && count > 0 ? "pointer" : "default",
          font: "inherit",
          transition: "background 0.12s, opacity 0.12s",
        }}
      >
        <span style={{ lineHeight: 1.2, fontWeight: todayCell ? 600 : 400 }}>{cell.day}</span>
        {count > 0 && cell.isCurrentMonth && (
          <span style={{ marginTop: 2, fontSize: 9, lineHeight: 1, opacity: 0.8 }}>
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

export function TodoMonthCalendar({
  todos,
  month,
  today,
  selectedDay,
  locale,
  onMonthChange,
  onSelectDay,
}: TodoMonthCalendarProps) {
  const { t } = useI18n();
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(hover: none), (pointer: coarse)");
    const update = () => setIsTouchDevice(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const cells = useMemo(() => buildCells(month.year, month.month), [month]);
  const todosByDay = useMemo(() => {
    const grouped = new Map<string, Todo[]>();
    for (const todo of todos) {
      if (todo.deadline == null) continue;
      const date = new Date(todo.deadline);
      if (date.getFullYear() !== month.year || date.getMonth() !== month.month) continue;
      const key = dateKey(todo.deadline);
      const list = grouped.get(key);
      if (list) list.push(todo);
      else grouped.set(key, [todo]);
    }
    return grouped;
  }, [month, todos]);
  const maxCount = useMemo(
    () => Math.max(0, ...Array.from(todosByDay.values(), (dayTodos) => dayTodos.length)),
    [todosByDay],
  );
  const monthLabel = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
  }).format(new Date(month.year, month.month, 1));
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  return (
    <section style={{ minHeight: "100%", padding: "8px 10px 12px" }} aria-label={t("Calendar")}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => onMonthChange(addMonths(month, -1))}
          aria-label={t("Previous month")}
          title={t("Previous month")}
          style={navButtonStyle}
        >
          ‹
        </button>
        <div style={{ flex: 1, textAlign: "center", fontSize: 13, fontWeight: 600 }}>{monthLabel}</div>
        <button
          type="button"
          onClick={() => onMonthChange(addMonths(month, 1))}
          aria-label={t("Next month")}
          title={t("Next month")}
          style={navButtonStyle}
        >
          ›
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 3, marginBottom: 3 }}>
        {weekdays.map((weekday) => (
          <div key={weekday} style={{ textAlign: "center", color: "var(--text-dim)", fontSize: 10, lineHeight: "18px" }}>
            {t(weekday)}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 3 }}>
        {cells.map((cell) => (
          <DayCell
            key={cell.ts}
            cell={cell}
            todos={cell.isCurrentMonth ? (todosByDay.get(dateKey(cell.ts)) ?? []) : []}
            maxCount={maxCount}
            today={today}
            selectedDay={selectedDay}
            isTouchDevice={isTouchDevice}
            onSelectDay={onSelectDay}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}

const navButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  padding: 0,
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 18,
  lineHeight: 1,
};
