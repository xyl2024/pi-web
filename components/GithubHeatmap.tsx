"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Tooltip } from "./Tooltip";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";

const COLS = 52;
const ROWS = 7;
const CELL = 12;
const GAP = 2;
const GRID_WIDTH = COLS * CELL + (COLS - 1) * GAP;

/** Local-time YYYY-MM-DD key — avoids UTC offset bugs that toISOString would cause. */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Contribution {
  date: string;
  count: number;
  level: number;
}

interface ApiResponse {
  contributions: Contribution[];
  total: number;
  username: string;
  updatedAt: number;
  stale?: boolean;
}

interface Props {
  username: string;
}

export function GithubHeatmap({ username }: Props) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/github/contributions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ApiResponse;
      setData(body);
      setError(null);
    } catch (e) {
      setError(String(e));
      toast.show({ kind: "error", message: t("Couldn't load GitHub activity") });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    setLoading(true);
    setSelectedDay(null);
    load();
  }, [load]);

  const byDay = useMemo(() => {
    const map = new Map<string, Contribution>();
    if (data) {
      for (const c of data.contributions) map.set(c.date, c);
    }
    return map;
  }, [data]);

  // Snap to start-of-week, then walk back (COLS-1) weeks
  const { start, today } = useMemo(() => {
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    const dow = t0.getDay();
    const offset = locale === "zh" ? (dow + 6) % 7 : dow;
    const s = new Date(t0);
    s.setDate(t0.getDate() - offset - (COLS - 1) * 7);
    return { start: s, today: t0 };
  }, [locale]);

  // Build cells column-major (one column per week, 7 rows of days)
  const cells = useMemo(() => {
    const out: Array<{ date: Date; key: string; level: number; count: number; future: boolean }> = [];
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const d = new Date(start);
        d.setDate(start.getDate() + c * 7 + r);
        const key = dateKey(d);
        const c0 = byDay.get(key);
        out.push({
          date: d,
          key,
          level: c0?.level ?? 0,
          count: c0?.count ?? 0,
          future: d > today,
        });
      }
    }
    return out;
  }, [start, today, byDay]);

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

  const cellStyle = (level: number, future: boolean): React.CSSProperties => {
    if (future) return { background: "transparent", pointerEvents: "none" as const };
    if (level === 0) return { background: "var(--bg-subtle)", cursor: "default" };
    return {
      background: level === 4
        ? "var(--accent)"
        : `color-mix(in srgb, var(--accent) ${level * 25}%, transparent)`,
      cursor: "pointer",
    };
  };

  const tooltipText = (d: Date, count: number): string => {
    const dateStr = d.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const unit = count === 1 ? t("contribution") : t("contributions");
    return locale === "zh" ? `${dateStr}：${count}${unit}` : `${dateStr}: ${count} ${unit}`;
  };

  const total = data?.total ?? 0;
  const selectedContrib = selectedDay ? byDay.get(selectedDay) ?? null : null;
  const selectedDate = selectedDay ? new Date(selectedDay) : null;
  const selectedIsFuture = selectedDate ? selectedDate > today : false;
  const selectedCount = selectedContrib?.count ?? 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: GRID_WIDTH,
        // Match SessionHeatmap's horizontal gutters so the two heatmaps line up
        margin: "0 52px 14px 16px",
        opacity: loading ? 0.55 : 1,
        transition: "opacity 0.2s",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: 6 }}>
        <a
          href={`https://github.com/${encodeURIComponent(username)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {`${total} ${t("contributions")} · @${username} · ${COLS} ${locale === "zh" ? "周" : "wks"}`}
        </a>
        {data?.stale && (
          <span style={{ marginLeft: 6 }}>· {t("stale")}</span>
        )}
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
                if (cell.future) return;
                setSelectedDay((cur) => (cur === cell.key ? null : cell.key));
              }}
              style={{
                width: CELL,
                height: CELL,
                borderRadius: 2,
                ...cellStyle(cell.level, cell.future),
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
          {t("Couldn't load GitHub activity")}
        </div>
      )}

      {!error && !loading && total === 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
          {t("No contribution data")}
        </div>
      )}

      {!error && selectedDay && selectedDate && !selectedIsFuture && (
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
            })} · ${selectedCount} ${selectedCount === 1 ? t("contribution") : t("contributions")}`}
          </div>
          <div style={{ padding: "6px 10px" }}>
            <a
              href={`https://github.com/${encodeURIComponent(username)}?tab=overview&from=${selectedDay}&to=${selectedDay}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "var(--accent)",
                textDecoration: "none",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
              }}
            >
              {t("View on GitHub")} →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export function GithubHeatmapPlaceholder() {
  const { t } = useI18n();
  return (
    <div
      style={{
        width: GRID_WIDTH,
        margin: "0 52px 14px 16px",
        textAlign: "center",
        fontSize: 11,
        color: "var(--text-dim)",
        fontFamily: "var(--font-mono)",
      }}
    >
      {t("Set your GitHub username in Settings to see your activity here.")}
    </div>
  );
}
