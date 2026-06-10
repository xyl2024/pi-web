"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";

const COLS = 52;
const ROWS = 7;
const CELL = 12;
const GAP = 2;
const MAX_SUB_LIST = 20;
const GRID_WIDTH = COLS * CELL + (COLS - 1) * GAP;

/** Local-time YYYY-MM-DD key — avoids UTC offset bugs that toISOString would cause. */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Props {
  cwd: string;
  onOpenSession?: (session: SessionInfo) => void;
}

export function SessionHeatmap({ cwd, onOpenSession }: Props) {
  const { t, locale } = useI18n();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions?cwd=" + encodeURIComponent(cwd));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: SessionInfo[] };
      setSessions(data.sessions);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setLoading(true);
    setSelectedDay(null);
    load();
  }, [load]);

  // Group by YYYY-MM-DD (local time)
  const sessionsByDay = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const d = new Date(s.created);
      if (Number.isNaN(d.getTime())) continue;
      const key = dateKey(d);
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [sessions]);

  // Snap to start-of-week, then walk back (COLS-1) weeks
  const { start, today } = useMemo(() => {
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    const dow = t0.getDay(); // Sun=0..Sat=6
    // en: week starts Sun → offset = dow. zh: week starts Mon → offset = (dow+6)%7
    const offset = locale === "zh" ? (dow + 6) % 7 : dow;
    const s = new Date(t0);
    s.setDate(t0.getDate() - offset - (COLS - 1) * 7);
    return { start: s, today: t0 };
  }, [locale]);

  // Build cells column-major (one column per week, 7 rows of days)
  const cells = useMemo(() => {
    const out: Array<{ date: Date; key: string; count: number; future: boolean; list: SessionInfo[] }> = [];
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const d = new Date(start);
        d.setDate(start.getDate() + c * 7 + r);
        const key = dateKey(d);
        const list = sessionsByDay.get(key) ?? [];
        out.push({ date: d, key, count: list.length, future: d > today, list });
      }
    }
    return out;
  }, [start, today, sessionsByDay]);

  // Month label per column — show the month of the first day when it differs from the previous column
  const monthLabels = useMemo(() => {
    const labels: Array<{ col: number; text: string }> = [];
    let prevMonth = -1;
    for (let c = 0; c < COLS; c++) {
      const firstDay = new Date(start);
      firstDay.setDate(start.getDate() + c * 7);
      if (firstDay.getMonth() !== prevMonth) {
        prevMonth = firstDay.getMonth();
        labels.push({
          col: c,
          text: firstDay.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { month: "short" }),
        });
      }
    }
    return labels;
  }, [start, locale]);

  const cellStyle = (count: number, future: boolean): React.CSSProperties => {
    if (future) return { background: "transparent", pointerEvents: "none" as const };
    if (count === 0) return { background: "var(--bg-subtle)", cursor: "default" };
    const idx = Math.min(count, 4); // 1..4
    return {
      background: idx === 4
        ? "var(--accent)"
        : `color-mix(in srgb, var(--accent) ${idx * 25}%, transparent)`,
      cursor: "pointer",
    };
  };

  const tooltipText = (d: Date, n: number): string => {
    const dateStr = d.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const unit = n === 1 ? t("session") : t("sessions");
    return locale === "zh" ? `${dateStr}：${n}${unit}` : `${dateStr}: ${n} ${unit}`;
  };

  const totalCount = sessions.length;
  const selectedList = selectedDay ? sessionsByDay.get(selectedDay) ?? [] : [];
  const selectedDate = selectedDay ? new Date(selectedDay) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        // Fixed width (not max-content) so the sublist's `width: 100%` doesn't
        // get inflated when a long session name pushes its max-content beyond
        // the grid width.
        width: GRID_WIDTH,
        // Match the title row's 16/52 left/right margins so the heatmap lines up
        // with the input box below (whose inner content is shifted left by ~30px
        // due to the 14px left padding and the 发送 button on the right).
        margin: "4px 52px 14px 16px",
        opacity: loading ? 0.55 : 1,
        transition: "opacity 0.2s",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: 6 }}>
        {`${totalCount} ${t("sessions")} · ${COLS} ${locale === "zh" ? "周" : "wks"}`}
      </div>

      {/* Month label row — uses the same grid track layout as the cells below so labels align column-by-column */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
          gap: GAP,
          height: 12,
          marginBottom: 4,
        }}
      >
        {monthLabels.map((m) => (
          <span
            key={m.col}
            style={{
              gridColumn: m.col + 1,
              fontSize: 10,
              lineHeight: "12px",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            {m.text}
          </span>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
          gridTemplateRows: `repeat(${ROWS}, ${CELL}px)`,
          gridAutoFlow: "column",
          gap: GAP,
        }}
      >
        {cells.map((cell) => {
          const cellEl = (
            <div
              onClick={() => {
                if (cell.list.length === 0) return;
                setSelectedDay((cur) => (cur === cell.key ? null : cell.key));
              }}
              style={{
                width: CELL,
                height: CELL,
                borderRadius: 2,
                ...cellStyle(cell.count, cell.future),
                outline: selectedDay === cell.key ? `1px solid var(--accent)` : "none",
                outlineOffset: 1,
              }}
            />
          );
          if (cell.future) {
            return <div key={cell.key}>{cellEl}</div>;
          }
          return (
            <Tooltip key={cell.key} content={tooltipText(cell.date, cell.count)}>
              {cellEl}
            </Tooltip>
          );
        })}
      </div>

      {/* Status / sublist */}
      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
          {t("Couldn't load activity")}
        </div>
      )}

      {!error && !loading && totalCount === 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
          {t("No activity in this workspace yet")}
        </div>
      )}

      {!error && selectedDay && selectedDate && selectedList.length > 0 && (
        <div
          style={{
            marginTop: 10,
            width: "100%",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "6px 10px",
              fontSize: 11,
              color: "var(--text-muted)",
              borderBottom: "1px solid var(--border)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {`${selectedDate.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })} · ${selectedList.length} ${selectedList.length === 1 ? t("session") : t("sessions")}`}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 200, overflowY: "auto" }}>
            {selectedList.slice(0, MAX_SUB_LIST).map((s) => {
              const msg = s.firstMessage && s.firstMessage !== "(no messages)" ? s.firstMessage : null;
              return (
                <li key={s.id}>
                  <button
                    onClick={() => onOpenSession?.(s)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      padding: "6px 10px",
                      cursor: "pointer",
                      color: "var(--text)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      fontFamily: "var(--font-mono)",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    {s.name ? (
                      <>
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: "var(--text)",
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {s.name}
                        </span>
                        {msg && (
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {msg}
                          </span>
                        )}
                      </>
                    ) : msg ? (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {msg}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {selectedList.length > MAX_SUB_LIST && (
            <div
              style={{
                padding: "4px 10px",
                fontSize: 11,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {t("+{n} more").replace("{n}", String(selectedList.length - MAX_SUB_LIST))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
