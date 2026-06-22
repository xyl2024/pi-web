"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarHeatmap, type CalendarHeatmapDatum } from "@goujon/react-calendar-heatmap";
import "@goujon/calendar-heatmap/calendar-heatmap.css";
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

const HEATMAP_WIDTH = 690;

/** Parse a "YYYY-MM-DD" string as local-midnight Date so the package's
 *  internal key matcher (which uses local `getFullYear/Month/Date`) lines up
 *  with the API's local-time date strings. `new Date("YYYY-MM-DD")` is parsed
 *  as UTC, which would mis-bin dates near midnight in non-UTC zones. */
const parseLocalDate = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

function readCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function GithubHeatmap({ username }: Props) {
  const { t, locale } = useI18n();
  const toast = useToast();
  // Subscribe to theme changes so colorRange (below) recomputes against the
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

  const heatmapData = useMemo<CalendarHeatmapDatum[]>(
    () =>
      (data?.contributions ?? []).map((c) => ({
        date: parseLocalDate(c.date),
        count: c.count,
      })),
    [data],
  );

  // Theme-aware gradient. Recomputed on each render; useTheme() above triggers a
  // re-render whenever the theme preset changes, so the new --accent / --bg-subtle
  // are picked up. No useMemo — the array identity isn't used as a hook dep.
  const colorRange = [
    readCssVar("--bg-subtle") || "rgba(0,0,0,0.06)",
    readCssVar("--accent") || "#2563eb",
  ];

  const tooltipFormatter = useCallback(
    (date: Date, count: number): string => {
      const dateStr = date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      const unit = count === 1 ? t("contribution") : t("contributions");
      return locale === "zh" ? `${dateStr}：${count}${unit}` : `${dateStr}: ${count} ${unit}`;
    },
    [t, locale],
  );

  // The package appends an SVG <title> per render to drive its `aria-label`,
  // which the browser renders as a native hover tooltip ("Calendar heatmap").
  // CSS `display:none` doesn't reliably suppress that tooltip, so we strip the
  // <title> elements out of the DOM via a MutationObserver attached once on mount.
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;
    const stripTitles = () => {
      for (const t of host.querySelectorAll("svg > title")) t.remove();
    };
    stripTitles();
    const observer = new MutationObserver(stripTitles);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const total = data?.total ?? 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: HEATMAP_WIDTH,
        margin: "0 auto 14px auto",
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

      <div ref={chartHostRef}>
        <CalendarHeatmap
          data={heatmapData}
          width={HEATMAP_WIDTH}
          fitWidth
          cellPadding={3}
          minCellSize={9}
          maxCellSize={13}
          weekStart={locale === "zh" ? "monday" : "sunday"}
          colorRange={colorRange}
          tooltipEnabled
          legendEnabled={false}
          formatters={{ tooltip: tooltipFormatter }}
          labels={{ day: { enabled: false }, month: { enabled: true, padding: 22 } }}
        />
      </div>

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
        width: HEATMAP_WIDTH,
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