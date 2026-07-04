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

// Piano-roll animation timing. Each active cell gets a CSS animation-delay
// equal to its position in the time-ordered *active* sequence (not the cells
// array index — inactive cells must not consume stagger slots).
const STAGGER_MS = 35;
const ANIM_DURATION_MS = 900;

interface Cell {
  x: number;
  y: number;
  date: Date;
  count: number;
  level: number;
  /** 0-based index within the active subset, or -1 for inactive cells. Drives
   *  the per-cell CSS animation-delay so the keyframes hit their bounce peak
   *  exactly when each cell's stagger window opens. */
  playIndex: number;
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
  activeCount: number;
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
  // playOrder[i] = the random 0..N-1 stagger slot assigned to cells[i] when
  // it is active; -1 for inactive cells. playVersion increments every cycle
  // so rect keys change → React remounts each <rect> → CSS re-reads
  // --gh-delay and restarts the bounce animation.
  const [playOrder, setPlayOrder] = useState<number[]>([]);
  const [playVersion, setPlayVersion] = useState(0);

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
    let activeIndex = 0;

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
        const count = inWindow ? entry.count : 0;
        // Only count toward the active subset if this cell has real activity.
        // Using `cells.length` here would burn stagger slots on inactive slots
        // and push the first active cell's bounce past the keyframes window.
        const playIndex = count > 0 ? activeIndex++ : -1;
        cells.push({
          x: LEFT_PAD + col * CELL_STEP,
          y: TOP_PAD + row * CELL_STEP,
          date,
          count,
          level: inWindow ? entry.level : 0,
          playIndex,
        });
      }
    }

    const svgW = LEFT_PAD + numCols * CELL_STEP - CELL_PADDING + RIGHT_PAD;
    const svgH = TOP_PAD + 7 * CELL_STEP - CELL_PADDING + BOTTOM_PAD;
    return { cells, monthLabels, svgW, svgH, activeCount: activeIndex };
  }, [data, dateLocale, weekStartsOn]);

  // Total cycle = stagger budget for every active cell + the per-cell animation
  // duration, so the last active cell finishes its bounce exactly as the first
  // cell restarts. Inactive cells don't get a CSS var and stay static.
  const activeCount = grid?.activeCount ?? 0;
  const totalCycleMs = activeCount * STAGGER_MS + ANIM_DURATION_MS;

  // (Re-)seed playOrder whenever the grid changes (first load, locale
  // switch). Mirrors cell.playIndex so each active cell starts in its
  // natural time-order slot on the very first frame, even before the first
  // setInterval tick fires.
  useEffect(() => {
    if (!grid) {
      setPlayOrder([]);
      return;
    }
    setPlayOrder(grid.cells.map((c) => c.playIndex));
  }, [grid]);

  // Re-shuffle the play order every full cycle so the bounce order is random
  // across rounds. Bumping playVersion forces rect remount → CSS re-reads
  // --gh-delay → animation restarts from frame 0 with the new ordering.
  useEffect(() => {
    if (!grid || activeCount === 0) return;
    const id = setInterval(() => {
      setPlayOrder((prev) => {
        if (prev.length === 0) return prev;
        const active = prev.filter((x) => x >= 0);
        // Fisher-Yates shuffle of the active stagger slots.
        for (let i = active.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [active[i], active[j]] = [active[j], active[i]];
        }
        const next = [...prev];
        let ai = 0;
        for (let k = 0; k < next.length; k++) {
          if (next[k] >= 0) next[k] = active[ai++];
        }
        return next;
      });
      setPlayVersion((v) => v + 1);
    }, totalCycleMs);
    return () => clearInterval(id);
  }, [grid, activeCount, totalCycleMs]);

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
          {grid.cells.map((c, i) => {
            const active = c.count > 0;
            // Use the randomized playOrder slot rather than the time-ordered
            // cell.playIndex — this is what makes each round's bounce order
            // random. Fallback to c.playIndex during the first render before
            // the grid → playOrder sync useEffect has run.
            const playIndex = active ? (playOrder[i] ?? c.playIndex) : -1;
            return (
              <rect
                key={`c-${i}-${playVersion}`}
                className={active ? "gh-cell gh-active" : "gh-cell"}
                style={
                  active
                    ? ({
                        "--gh-delay": `${playIndex * STAGGER_MS}ms`,
                        "--gh-cycle": `${totalCycleMs}ms`,
                      } as React.CSSProperties)
                    : undefined
                }
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
                {active && (
                  <circle
                    key={`note-${i}-${playVersion}`}
                    className="gh-note"
                    cx={c.x + CELL_SIZE / 2}
                    cy={c.y + CELL_SIZE / 2}
                    r={1.5}
                    fill="var(--accent)"
                  />
                )}
              </rect>
            );
          })}
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