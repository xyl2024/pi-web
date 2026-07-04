"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useToast } from "./Toast";

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

// Layout constants. 11px cells with a 3px gap match the density of typical
// GitHub-style contribution graphs.
const CELL_SIZE = 11;
const CELL_PADDING = 3;
const CELL_STEP = CELL_SIZE + CELL_PADDING; // 14
const LEFT_PAD = 24;
const TOP_PAD = 18;
const RIGHT_PAD = 4;
const BOTTOM_PAD = 4;
const WINDOW_DAYS = 180;
const MAX_WIDTH = 690;

interface Cell {
  x: number;
  y: number;
  date: Date;
  count: number;
  level: number;
}

interface MonthLabel {
  x: number;
  label: string;
}

interface Grid {
  cells: Cell[];
  monthLabels: MonthLabel[];
  svgW: number;
  svgH: number;
}

/** Format a Date as local "YYYY-MM-DD" without going through toISOString
 *  (which would emit UTC and shift the date by the local offset). */
function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function readCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Convert "#rrggbb" or "#rgb" to "rgba(r, g, b, alpha)". Falls back to the
 *  input string if parsing fails so a future theme change to `rgb(...)`
 *  doesn't blank out the chart. */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Recomputed each render. useTheme() above triggers a re-render whenever
 *  the theme preset changes, so the new --bg-subtle / --accent are picked up
 *  via readCssVar. O(1) — no useMemo needed. */
function buildPalette(): string[] {
  const subtle = readCssVar("--bg-subtle") || "rgba(0,0,0,0.06)";
  const accent = readCssVar("--accent") || "#2563eb";
  return [
    subtle,
    hexToRgba(accent, 0.15),
    hexToRgba(accent, 0.35),
    hexToRgba(accent, 0.6),
    hexToRgba(accent, 0.85),
  ];
}

export function GithubHeatmap({ username }: Props) {
  const { t, locale } = useI18n();
  const toast = useToast();
  // Subscribe to theme changes so buildPalette() below recomputes against the
  // active --accent / --bg-subtle. The return value isn't used directly — the
  // subscription itself is the point.
  useTheme();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    load();
  }, [load]);

  const weekStartsOn: 0 | 1 = locale === "zh" ? 1 : 0; // 0 = Sunday, 1 = Monday
  const dateLocale = locale === "zh" ? "zh-CN" : "en-US";

  const grid = useMemo<Grid | null>(() => {
    if (!data) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowEnd = today;
    const windowStart = addDays(today, -(WINDOW_DAYS - 1));

    // Align the grid left edge to the locale's week start so row 0 is always
    // Sunday (en) or Monday (zh), regardless of where the 180-day window lands.
    const startOffset = (windowStart.getDay() - weekStartsOn + 7) % 7;
    const gridStart = addDays(windowStart, -startOffset);

    const totalDays =
      Math.floor((windowEnd.getTime() - gridStart.getTime()) / 86400000) + 1;
    const numCols = Math.ceil(totalDays / 7);

    // O(1) per-cell lookup. The API returns a full year; we only render the
    // 180-day window but the map is cheap to build and saves repeated
    // array.find scans per render.
    const lookup = new Map<string, { count: number; level: number }>();
    for (const c of data.contributions) {
      lookup.set(c.date, { count: c.count, level: c.level });
    }

    const cells: Cell[] = [];
    const monthLabels: MonthLabel[] = [];
    let lastMonth = -1;

    for (let col = 0; col < numCols; col++) {
      const colStart = addDays(gridStart, col * 7);

      // Month label only on the first column whose first row enters a new month.
      if (colStart.getMonth() !== lastMonth) {
        lastMonth = colStart.getMonth();
        monthLabels.push({
          x: LEFT_PAD + col * CELL_STEP,
          label: colStart.toLocaleDateString(dateLocale, { month: "short" }),
        });
      }

      for (let row = 0; row < 7; row++) {
        const date = addDays(colStart, row);
        const dateStr = formatYMD(date);
        const entry = lookup.get(dateStr) ?? { count: 0, level: 0 };
        const inWindow =
          date.getTime() >= windowStart.getTime() &&
          date.getTime() <= windowEnd.getTime();
        cells.push({
          x: LEFT_PAD + col * CELL_STEP,
          y: TOP_PAD + row * CELL_STEP,
          date,
          count: inWindow ? entry.count : 0,
          level: inWindow ? entry.level : 0,
        });
      }
    }

    const svgW = LEFT_PAD + numCols * CELL_STEP - CELL_PADDING + RIGHT_PAD;
    const svgH = TOP_PAD + 7 * CELL_STEP - CELL_PADDING + BOTTOM_PAD;
    return { cells, monthLabels, svgW, svgH };
  }, [data, dateLocale, weekStartsOn]);

  const tooltipFormatter = useCallback(
    (date: Date, count: number): string => {
      const dateStr = date.toLocaleDateString(dateLocale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      const unit = count === 1 ? t("contribution") : t("contributions");
      return locale === "zh" ? `${dateStr}：${count}${unit}` : `${dateStr}: ${count} ${unit}`;
    },
    [t, locale, dateLocale],
  );

  const palette = buildPalette();
  const total = data?.total ?? 0;

  return (
    <div
      style={{
        width: "100%",
        maxWidth: MAX_WIDTH,
        margin: "0 auto 14px auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
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
          {`${total} ${t("contributions")} · @${username}`}
        </a>
        {data?.stale && <span style={{ marginLeft: 6 }}>· {t("stale")}</span>}
      </div>

      {grid && (
        <svg
          style={{ width: "100%", height: "auto", display: "block" }}
          viewBox={`0 0 ${grid.svgW} ${grid.svgH}`}
          preserveAspectRatio="xMinYMin meet"
          role="img"
          aria-label={`${total} ${t("contributions")} · @${username}`}
        >
          {grid.monthLabels.map((m, i) => (
            <text
              key={`m-${i}`}
              x={m.x}
              y={2}
              fontSize={10}
              fill="var(--text-dim)"
              fontFamily="var(--font-mono)"
              dominantBaseline="hanging"
            >
              {m.label}
            </text>
          ))}
          {grid.cells.map((c, i) => (
            <rect
              key={`c-${i}`}
              className="gh-cell"
              x={c.x}
              y={c.y}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={2}
              fill={palette[c.level] ?? palette[0]}
              role="img"
              aria-label={tooltipFormatter(c.date, c.count)}
            >
              <title>{tooltipFormatter(c.date, c.count)}</title>
            </rect>
          ))}
        </svg>
      )}

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
    </div>
  );
}

export function GithubHeatmapPlaceholder() {
  const { t } = useI18n();
  return (
    <div
      style={{
        width: "100%",
        maxWidth: MAX_WIDTH,
        margin: "0 auto 14px auto",
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