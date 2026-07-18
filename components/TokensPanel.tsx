"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { useConfirm } from "./ConfirmDialog";
import { Tooltip } from "./Tooltip";
import type { SessionInfo } from "@/lib/types";
import { zeroPadHourSeries } from "@/lib/hour-series";
import type { HourBucket, SummaryBucket } from "@/lib/token-audit-types";

type Range = "today" | "7d" | "30d" | "all";
type GroupBy = "none" | "session" | "model" | "hour";
type SortKey = "ts" | "outputTokens" | "durationMs" | "costTotal";

interface TokenCallRow {
  id: number;
  ts: number;
  sessionId: string;
  messageId: string;
  source: "user" | "scheduled";
  provider: string;
  modelId: string;
  api: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costRead: number;
  costWrite: number;
  costTotal: number;
  durationMs: number;
  error: string | null;
}

interface SummaryResponse {
  buckets: SummaryBucket[];
  totals: SummaryBucket;
}

interface CallsResponse {
  rows: TokenCallRow[];
  total: number;
}

interface TokensPanelProps {
  onSelectSession: (session: SessionInfo) => void;
}

const RANGES: Range[] = ["today", "7d", "30d", "all"];
const GROUP_BYS_FOR_UI: GroupBy[] = ["none", "session", "model", "hour"];
const PAGE_LIMIT = 100;

// CSS keyframes used by the Refresh icon when loading. Defined here as a
// string rather than a separate stylesheet so the component stays self-contained
// (TokensPanel mounts as a single dynamic-less unit).
const SPIN_KEYFRAMES = `
@keyframes token-panel-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function cacheHitRate(totals: SummaryBucket): number | null {
  const denom = totals.inputTokens + totals.cacheReadTokens;
  if (denom === 0) return null;
  return totals.cacheReadTokens / denom;
}

export function TokensPanel({ onSelectSession }: TokensPanelProps) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [range, setRange] = useState<Range>("7d");
  // Default to flat list — groupBy-driven visualization is a second click.
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [calls, setCalls] = useState<CallsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // The UI hides "hour" when range isn't "today" (and silently downgrades it
  // back to "none") — the 24h chart isn't useful on week+ ranges.
  const effectiveGroupBy: GroupBy = groupBy === "hour" && range !== "today" ? "none" : groupBy;
  const availableGroupBys = useMemo<GroupBy[]>(
    () => (range === "today" ? GROUP_BYS_FOR_UI : GROUP_BYS_FOR_UI.filter((g) => g !== "hour")),
    [range],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, cRes] = await Promise.all([
        fetch(`/api/token-audit/summary?range=${range}&groupBy=${effectiveGroupBy}`),
        fetch(`/api/token-audit/calls?range=${range}&limit=${PAGE_LIMIT}&offset=${offset}`),
      ]);
      if (!sRes.ok || !cRes.ok) throw new Error(`HTTP ${sRes.status}/${cRes.status}`);
      const [s, c] = (await Promise.all([sRes.json(), cRes.json()])) as [SummaryResponse, CallsResponse];
      setSummary(s);
      setCalls(c);
      // If the page we were on no longer exists (e.g. after Clear), bounce back
      // to the first page rather than showing an empty list forever.
      if (offset > 0 && offset >= c.total) setOffset(0);
    } catch (e) {
      toast.show({ kind: "error", message: `${t("Failed to load token audit")}: ${String(e)}` });
    } finally {
      setLoading(false);
    }
    // effectiveGroupBy is computed in render from (groupBy, range); include
    // groupBy/range so we re-fetch on filter change. offset is a separate
    // signal — pagination handles it via the dedicated useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, groupBy, offset, toast, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Reset pagination whenever the user changes range or groupBy — fetched
  // windows don't carry across groupBy/range changes because the totals change.
  useEffect(() => {
    setOffset(0);
  }, [range, groupBy]);

  const handleClear = useCallback(async () => {
    if (!calls || calls.total === 0) return;
    const ok = await confirm({
      title: t("Clear all token audit data?"),
      description: t("This will permanently delete all recorded token usage."),
      confirmLabel: t("Clear all"),
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await fetch("/api/token-audit/data", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.show({ kind: "success", message: t("Token audit cleared") });
      setOffset(0);
      void reload();
    } catch (e) {
      toast.show({ kind: "error", message: String(e) });
    }
  }, [calls, confirm, toast, t, reload]);

  const sortedRows = useMemo<TokenCallRow[]>(() => {
    if (!calls) return [];
    const copy = [...calls.rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [calls, sortKey, sortDir]);

  const totals = summary?.totals;
  const hitRate = totals ? cacheHitRate(totals) : null;
  const hasData = !!calls && calls.total > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <style dangerouslySetInnerHTML={{ __html: SPIN_KEYFRAMES }} />
      <Toolbar
        range={range}
        groupBy={groupBy}
        effectiveGroupBy={effectiveGroupBy}
        availableGroupBys={availableGroupBys}
        loading={loading}
        calls={calls}
        onChangeRange={setRange}
        onChangeGroupBy={setGroupBy}
        onReload={() => void reload()}
        onClear={() => void handleClear()}
        canClear={hasData}
      />
      <SummaryStrip totals={totals} hitRate={hitRate} />

      {effectiveGroupBy !== "none" && summary && (
        <Visualization groupBy={effectiveGroupBy} buckets={summary.buckets} range={range} />
      )}

      <CallsList
        rows={sortedRows}
        loading={loading}
        sortKey={sortKey}
        sortDir={sortDir}
        onChangeSort={(k) => {
          if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
          else { setSortKey(k); setSortDir("desc"); }
        }}
        onSelectSession={onSelectSession}
        hasData={hasData}
      />

      {calls && calls.total > PAGE_LIMIT && (
        <Pagination offset={offset} total={calls.total} onChange={setOffset} />
      )}
    </div>
  );
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function rangeLabel(r: Range, t: (key: string) => string): string {
  if (r === "today") return t("Today");
  if (r === "7d") return t("Last 7 days");
  if (r === "30d") return t("Last 30 days");
  return t("All time");
}

interface ToolbarProps {
  range: Range;
  groupBy: GroupBy;
  effectiveGroupBy: GroupBy;
  availableGroupBys: GroupBy[];
  loading: boolean;
  calls: CallsResponse | null;
  canClear: boolean;
  onChangeRange: (r: Range) => void;
  onChangeGroupBy: (g: GroupBy) => void;
  onReload: () => void;
  onClear: () => void;
}

function Toolbar({
  range,
  groupBy,
  availableGroupBys,
  loading,
  calls,
  canClear,
  onChangeRange,
  onChangeGroupBy,
  onReload,
  onClear,
}: ToolbarProps) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        flexWrap: "wrap",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginRight: 4 }}>
        {t("Token audit")}
      </span>
      {RANGES.map((r) => (
        <ChipButton
          key={r}
          active={range === r}
          onClick={() => onChangeRange(r)}
          label={rangeLabel(r, t)}
        />
      ))}
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("Group by")}</span>
        <select
          value={groupBy}
          onChange={(e) => onChangeGroupBy(e.target.value as GroupBy)}
          style={{
            fontSize: 11,
            padding: "2px 4px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            maxWidth: 130,
          }}
        >
          {availableGroupBys.map((g) => (
            <option key={g} value={g}>
              {g === "none"
                ? t("Flat list")
                : g === "session"
                  ? t("By session")
                  : g === "model"
                    ? t("By model")
                    : t("By hour (24h)")}
            </option>
          ))}
        </select>
      </label>
      <div style={{ flex: 1 }} />
      {calls && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {t("Showing {n} of {total}")
            .replace("{n}", String(calls.rows.length))
            .replace("{total}", String(calls.total))}
        </span>
      )}
      <Tooltip content={t("Refresh")}>
        <IconButton onClick={onReload} ariaLabel={t("Refresh")} disabled={loading}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={loading ? { animation: "token-panel-spin 1s linear infinite" } : undefined}
          >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <polyline points="21 4 21 12 13 12" />
          </svg>
        </IconButton>
      </Tooltip>
      <Tooltip content={t("Clear all token audit data?")}>
        <IconButton onClick={onClear} ariaLabel={t("Clear all")} disabled={!canClear}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </svg>
        </IconButton>
      </Tooltip>
    </div>
  );
}

// ── Summary strip ──────────────────────────────────────────────────────────

interface SummaryStripProps {
  totals: SummaryBucket | undefined;
  hitRate: number | null;
}

function SummaryStrip({ totals, hitRate }: SummaryStripProps) {
  const { t } = useI18n();
  if (!totals) {
    // Same 5 placeholder slots while first fetch is in flight, to avoid layout jump.
    return (
      <div style={stripBoxStyle}>
        {(["", "", "", "", ""]).map((_, i) => (
          <SummaryItem key={i} label={i === 0 ? t("Total cost") : i === 1 ? t("Total tokens") : i === 2 ? t("Input tokens") : i === 3 ? t("Output tokens") : t("Cache hit rate")} value="—" />
        ))}
      </div>
    );
  }
  const totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  return (
    <div style={stripBoxStyle}>
      <SummaryItem
        label={t("Total cost")}
        value={formatCost(totals.costTotal)}
        color="var(--accent)"
      />
      <SummaryItem label={t("Total tokens")} value={formatNumber(totalTokens)} />
      <SummaryItem
        label={t("Input tokens")}
        value={formatNumber(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}
        sub={t("incl. cache")}
      />
      <SummaryItem label={t("Output tokens")} value={formatNumber(totals.outputTokens)} />
      <SummaryItem
        label={t("Cache hit rate")}
        value={hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`}
        sub={totals.cacheReadTokens > 0 ? `${formatNumber(totals.cacheReadTokens)} ${t("Cache read")}` : undefined}
      />
    </div>
  );
}

const stripBoxStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 8,
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-panel)",
  flexShrink: 0,
  flexWrap: "wrap",
};

function SummaryItem({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, minWidth: 64, flex: 1 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: color ?? "var(--text)", fontFamily: "var(--font-mono)" }}>{value}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{label}</span>
      {sub && <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{sub}</span>}
    </div>
  );
}

// ── Visualization ──────────────────────────────────────────────────────────

interface VisualizationProps {
  groupBy: "session" | "model" | "hour";
  buckets: SummaryBucket[];
  range: Range;
}

function Visualization({ groupBy, buckets, range }: VisualizationProps) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        flexShrink: 0,
        maxHeight: 168,
        overflowY: "auto",
        padding: "6px 12px 8px",
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
        {groupBy === "hour" ? "Last 24 hours" : groupBy === "session" ? "By session" : "By model"}
      </div>
      {groupBy === "hour" ? (
        <HourlyChart buckets={buckets as HourBucket[]} range={range} />
      ) : (
        <BucketBars buckets={buckets} />
      )}
    </div>
  );
}

/** Horizontal bars, one per bucket — normalized to max costTotal. */
function BucketBars({ buckets }: { buckets: SummaryBucket[] }) {
  const { t } = useI18n();
  if (buckets.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>{t("No token usage recorded yet.")}</div>;
  }
  const maxCost = Math.max(...buckets.map((b) => b.costTotal), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {buckets.map((b) => {
        const pct = maxCost > 0 ? (b.costTotal / maxCost) * 100 : 0;
        return (
          <div key={b.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Tooltip content={b.key}>
              <span
                style={{
                  flexShrink: 0,
                  maxWidth: 140,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {b.key}
              </span>
            </Tooltip>
            <div style={{ flex: 1, height: 8, background: "var(--bg-subtle)", borderRadius: 2, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: "var(--accent)",
                  transition: "width 0.3s",
                  minWidth: b.costTotal > 0 ? 2 : 0,
                }}
              />
            </div>
            <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)", flexShrink: 0, minWidth: 56, textAlign: "right" }}>
              {formatCost(b.costTotal)}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0, minWidth: 36, textAlign: "right" }}>
              {b.calls}×
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 24-hour bar chart (per-hour buckets from the server). */
function HourlyChart({ buckets, range }: { buckets: HourBucket[]; range: Range }) {
  const { t } = useI18n();
  // `now` is read lazily so we don't trip the "no impure calls during render"
  // rule. It is stable for the lifetime of the component instance, so the
  // 24h chart axis doesn't drift on every re-render — Refresh re-mounts the
  // chart (key on the parent re-renders) anyway when range changes.
  const [now] = useState<number>(() => Date.now());
  const series: HourBucket[] =
    range === "today"
      ? zeroPadHourSeries(startOfLocalDay(now), endOfLocalHour(now), buckets)
      : buckets;

  if (series.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>{t("No token usage recorded yet.")}</div>;
  }
  const maxCalls = Math.max(...series.map((b) => b.calls), 1);
  const n = series.length;
  // SVG slot layout — each slot is 6 viewBox units wide, 60 max high.
  const VBW = n * 6;
  const rects = series.map((b, i) => {
    const h = b.calls === 0 ? 1 : Math.max(2, Math.round((b.calls / maxCalls) * 56));
    return (
      <g key={i}>
        <rect
          x={i * 6 + 0.5}
          y={60 - h}
          width={5}
          height={h}
          rx={0.6}
          fill={b.calls === 0 ? "var(--bg-subtle)" : "var(--accent)"}
          opacity={b.calls === 0 ? 0.5 : 0.9}
        >
          <title>
            {`${b.key} · ${b.calls} ${t("Calls")}${b.costTotal > 0 ? ` · ${formatCost(b.costTotal)}` : ""}`}
          </title>
        </rect>
      </g>
    );
  });
  // Horizontal hour axis labels — sparse (every 4 hours).
  const labels: React.ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const hour = parseHourFromBucketKey(series[i].key);
    if (hour !== null && hour % 4 === 0) {
      labels.push(
        <text
          key={i}
          x={i * 6 + 3}
          y={75}
          fontSize={4.5}
          fill="var(--text-dim)"
          textAnchor="middle"
          fontFamily="var(--font-mono)"
        >
          {`${String(hour).padStart(2, "0")}:00`}
        </text>,
      );
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <svg viewBox={`0 0 ${VBW} 80`} preserveAspectRatio="none" width="100%" height={84} style={{ display: "block" }}>
        {rects}
        <line x1={0} y1={60} x2={VBW} y2={60} stroke="var(--border)" strokeWidth={0.5} />
        {labels}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
        <span>{t("Calls")} {maxCalls === 0 ? 0 : Math.round(maxCalls)}</span>
        <span>{series.reduce((s, b) => s + b.calls, 0)} {t("Calls").toLowerCase()}</span>
      </div>
    </div>
  );
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfLocalHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(59, 59, 999);
  return d.getTime();
}
function parseHourFromBucketKey(key: string): number | null {
  const m = / (\d{2}):(\d{2})$/.exec(key);
  if (!m) return null;
  const h = +m[1];
  return Number.isFinite(h) ? h : null;
}

// ── Calls list (vertical cards) ───────────────────────────────────────────

interface CallsListProps {
  rows: TokenCallRow[];
  loading: boolean;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onChangeSort: (k: SortKey) => void;
  onSelectSession: (session: SessionInfo) => void;
  hasData: boolean;
}

function CallsList({
  rows,
  loading,
  sortKey,
  sortDir,
  onChangeSort,
  onSelectSession,
  hasData,
}: CallsListProps) {
  const { t } = useI18n();
  if (!hasData) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          fontSize: 12,
          color: "var(--text-dim)",
          textAlign: "center",
          fontStyle: "italic",
          padding: "32px 16px",
        }}
      >
        {loading ? t("Loading...") : t("No token usage recorded yet.")}
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <SortBar sortKey={sortKey} sortDir={sortDir} onChange={onChangeSort} />
      {rows.map((r) => (
        <CallCard key={r.id} row={r} onSelectSession={onSelectSession} />
      ))}
    </div>
  );
}

function SortBar({
  sortKey,
  sortDir,
  onChange,
}: {
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onChange: (k: SortKey) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        position: "sticky",
        top: 0,
        zIndex: 1,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("Sort by")}</span>
      <select
        value={sortKey}
        onChange={(e) => onChange(e.target.value as SortKey)}
        style={{
          fontSize: 10,
          padding: "1px 4px",
          borderRadius: 3,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <option value="ts">{t("Sort: time")}</option>
        <option value="costTotal">{t("Sort: cost")}</option>
        <option value="durationMs">{t("Sort: duration")}</option>
        <option value="outputTokens">{t("Sort: output")}</option>
      </select>
      <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {sortDir === "desc" ? "▼" : "▲"}
      </span>
    </div>
  );
}

function CallCard({ row, onSelectSession }: { row: TokenCallRow; onSelectSession: (s: SessionInfo) => void }) {
  const handleSessionClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelectSession({
        id: row.sessionId,
        path: "",
        cwd: "",
        created: "",
        modified: "",
        messageCount: 0,
      } as SessionInfo);
    },
    [onSelectSession, row.sessionId],
  );
  const isError = !!row.error;
  const tokenIn = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
  return (
    <div
      onClick={handleSessionClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "6px 12px",
        borderBottom: "1px solid var(--border)",
        background: isError ? "rgba(239, 68, 68, 0.06)" : "transparent",
        cursor: "pointer",
        transition: "background 0.1s",
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        if (!isError) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isError ? "rgba(239, 68, 68, 0.06)" : "transparent";
      }}
    >
      {/* Row 1: time + session chip + model + cost + duration */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
        <span style={{ color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatTime(row.ts)}</span>
        <SessionChip sessionId={row.sessionId} onClick={handleSessionClick} />
        <span
          style={{
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
          title={`${row.provider}/${row.modelId}`}
        >
          {row.provider}/{row.modelId}
        </span>
        <span
          style={{
            flexShrink: 0,
            color: "var(--accent)",
            fontWeight: 600,
            minWidth: 50,
            textAlign: "right",
          }}
        >
          {formatCost(row.costTotal)}
        </span>
        <span
          style={{
            flexShrink: 0,
            color: "var(--text-muted)",
            minWidth: 42,
            textAlign: "right",
          }}
        >
          {formatDuration(row.durationMs)}
        </span>
        {isError && (
          <Tooltip content={row.error ?? "error"}>
            <span style={{ color: "#f87171", fontSize: 11, flexShrink: 0 }}>!</span>
          </Tooltip>
        )}
      </div>
      {/* Row 2: token breakdown */}
      <div style={{ display: "flex", gap: 10, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", paddingLeft: 56 }}>
        <span>in {formatNumber(tokenIn)}</span>
        <span>out {formatNumber(row.outputTokens)}</span>
        <span title="cache read">↓ {formatNumber(row.cacheReadTokens)}</span>
      </div>
    </div>
  );
}

function SessionChip({ sessionId, onClick }: { sessionId: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      title={sessionId}
      style={{
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--accent)",
        background: "transparent",
        border: "1px solid var(--border)",
        padding: "0 6px",
        height: 16,
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      {sessionId.slice(0, 8)}
    </button>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (n: number) => void }) {
  const { t } = useI18n();
  const page = Math.floor(offset / PAGE_LIMIT) + 1;
  const pages = Math.ceil(total / PAGE_LIMIT);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "4px 12px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
        fontSize: 11,
      }}
    >
      <button
        onClick={() => onChange(Math.max(0, offset - PAGE_LIMIT))}
        disabled={offset === 0}
        style={pageBtnStyle(offset === 0)}
      >
        {t("Previous page")}
      </button>
      <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {page} / {pages}
      </span>
      <button
        onClick={() => onChange(offset + PAGE_LIMIT < total ? offset + PAGE_LIMIT : offset)}
        disabled={offset + PAGE_LIMIT >= total}
        style={pageBtnStyle(offset + PAGE_LIMIT >= total)}
      >
        {t("Next page")}
      </button>
    </div>
  );
}

function pageBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "2px 10px",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
  };
}

// ── ChipButton / IconButton ────────────────────────────────────────────────

function ChipButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 4,
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--bg-selected)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-muted)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        transition: "all 0.1s",
      }}
    >
      {label}
    </button>
  );
}

function IconButton({
  onClick,
  ariaLabel,
  disabled,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        padding: 0,
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: 6,
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
