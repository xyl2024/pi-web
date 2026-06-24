"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";

export interface CapturedPayloadSummary {
  status: number | null;
  /** Wall-clock duration of the provider call (response.timestamp - request.timestamp). */
  durationMs: number | null;
  /** Size of the serialized request body in bytes (UTF-8). */
  requestSize: number;
  /** Size of the response.headers block in bytes (serialized). */
  responseHeadersSize: number;
}

interface Props {
  sessionId: string;
  entryId: string;
  anchorEl: HTMLElement;
  onClose: () => void;
  /** Called with a small summary when the payload loads successfully. */
  onLoaded?: (summary: CapturedPayloadSummary) => void;
}

interface FetchedPayload {
  index: number;
  timestamp: number;
  payload: unknown;
  response?: {
    status: number;
    headers: Record<string, string>;
    timestamp: number;
  };
}

/**
 * Floating popover anchored to a chip. Shows the captured provider request
 * body, response headers, and a "Copy as cURL" button.
 *
 * Positioning: fixed, anchored to the right of the trigger. If the popover
 * would overflow the viewport on the right, it flips to the left. Top is
 * clamped so the popover stays inside the viewport.
 */
export function PayloadPopover({ sessionId, entryId, anchorEl, onClose, onLoaded }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<FetchedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // ── Fetch ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/payloads?entryId=${encodeURIComponent(entryId)}`)
      .then(async (r) => {
        if (!r.ok) {
          if (r.status === 404) throw new Error("no_payload");
          throw new Error(`http_${r.status}`);
        }
        return r.json();
      })
      .then((d: FetchedPayload) => {
        if (cancelled) return;
        setData(d);
        onLoaded?.(summarize(d));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "no_payload") {
          setError("no_payload");
        } else {
          setError(msg);
          toast.show({ kind: "error", message: t("Failed to load payloads") });
        }
      });
    return () => {
      cancelled = true;
    };
    // onLoaded intentionally omitted — setters are stable, this would just
    // re-fire on every parent render. Captured via the closure of the
    // resolved promise above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, entryId, reloadKey, t, toast]);

  // ── Portal mount guard (SSR safety) ──────────────────────────────────────
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  useEffect(() => setPortalEl(document.body), []);

  // ── Popover ref (used by close-on-outside handler) ───────────────────────
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // ── Close on outside / Esc ───────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorEl.contains(t)) return; // re-click on trigger is the chip's job
      if (popoverRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [onClose, anchorEl]);

  // ── Derived display ──────────────────────────────────────────────────────
  const view = useMemo(() => {
    if (error === "no_payload") return <EmptyState />;
    if (error) return <ErrorBlock message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
    if (!data) return <LoadingSkeleton />;
    return <LoadedView data={data} t={t} onCopyCurl={() => copyCurl(data, toast, t)} />;
  }, [data, error, t, toast]);

  if (!portalEl) return null;

  return createPortal(
    <>
      {/* Dark overlay */}
      <div
        aria-hidden
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.55)",
          zIndex: 999,
          animation: "payload-fade-in 80ms ease",
        }}
      />
      {/* Centered wrapper — pointerEvents: none lets the overlay receive
          clicks anywhere except inside the popover. */}
      <div
        style={{
          position: "fixed", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 1000,
          pointerEvents: "none",
        }}
      >
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("View API request for this response")}
          style={{
            width: Math.min(0.7 * (typeof window !== "undefined" ? window.innerWidth : 1024), Math.max(480, (typeof window !== "undefined" ? window.innerWidth : 1024) - 32)),
            maxHeight: "calc(100vh - 48px)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
            display: "flex",
            flexDirection: "column",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            pointerEvents: "auto",
            animation: "payload-fade-in 80ms ease",
          }}
        >
        <Header data={data} onClose={onClose} t={t} />
        <div style={{ overflow: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          {view}
        </div>
        </div>
      </div>
      <style>{`
        @keyframes payload-fade-in {
          from { opacity: 0; transform: translateY(-2px); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>
    </>,
    portalEl
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Header({
  data, onClose, t,
}: { data: FetchedPayload | null; onClose: () => void; t: ReturnType<typeof useI18n>["t"] }) {
  const status = data?.response?.status;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", borderBottom: "1px solid var(--border)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700 }}>{t("Provider API Requests")}</span>
      {data && (
        <span style={{
          fontSize: 10, padding: "1px 6px", borderRadius: 3,
          background: status === undefined ? "var(--bg-selected)" : status >= 400 ? "rgba(248,113,113,0.85)" : status >= 300 ? "rgba(234,179,8,0.85)" : "rgba(74,222,128,0.85)",
          color: status !== undefined && status < 500 ? "#0b0b0b" : "#fff",
        }}>
          {status ?? "…"}
        </span>
      )}
      <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>#{data?.index ?? "—"}</span>
      <button
        onClick={onClose}
        aria-label={t("Close")}
        style={{
          background: "none", border: "none", color: "var(--text-muted)",
          cursor: "pointer", padding: "0 6px", fontSize: 16, lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

function LoadedView({ data, t, onCopyCurl }: { data: FetchedPayload; t: ReturnType<typeof useI18n>["t"]; onCopyCurl: () => void }) {
  const ts = new Date(data.timestamp);
  const tsLabel = `${ts.toLocaleTimeString()}.${String(ts.getMilliseconds()).padStart(3, "0")}`;
  const requestJson = JSON.stringify(data.payload, null, 2);
  const requestSize = byteSize(requestJson);
  const responseHeaders = data.response ? JSON.stringify(data.response.headers, null, 2) : "";
  const responseHeadersSize = data.response ? byteSize(responseHeaders) : 0;
  const durationMs = data.response ? data.response.timestamp - data.timestamp : null;

  return (
    <>
      <MetaGrid
        rows={[
          [t("Payload status code"), data.response ? String(data.response.status) : t("API request pending")],
          [t("Payload duration"), durationMs !== null ? formatMs(durationMs) : "—"],
          [t("Timestamp"), tsLabel],
          [t("Request body size"), `${requestSize.toLocaleString()} B`],
          [t("Response headers size"), `${responseHeadersSize.toLocaleString()} B`],
        ]}
      />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={onCopyCurl}
          style={{
            background: "var(--bg-selected)", border: "1px solid var(--border)", borderRadius: 4,
            color: "var(--text)", cursor: "pointer", padding: "4px 10px", fontSize: 11,
            fontFamily: "var(--font-mono)",
          }}
        >
          {t("Copy as cURL")}
        </button>
      </div>
      <Section title={t("Request body")}>
        <pre style={jsonPreStyle}>{requestJson}</pre>
      </Section>
      {data.response && (
        <Section title={t("Response headers")}>
          <pre style={jsonPreStyle}>{responseHeaders}</pre>
        </Section>
      )}
    </>
  );
}

function MetaGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", fontSize: 11 }}>
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <span style={{ color: "var(--text-dim)" }}>{k}</span>
          <span style={{ color: "var(--text)" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px" }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: "contents" }}>
            <div style={{ height: 10, width: 80, background: "var(--bg-selected)", borderRadius: 3, animation: "payload-pulse 1.2s ease-in-out infinite" }} />
            <div style={{ height: 10, background: "var(--bg-selected)", borderRadius: 3, animation: "payload-pulse 1.2s ease-in-out infinite" }} />
          </div>
        ))}
      </div>
      <div style={{ height: 200, background: "var(--bg-selected)", borderRadius: 4, animation: "payload-pulse 1.2s ease-in-out infinite" }} />
      <style>{`@keyframes payload-pulse { 0%,100% { opacity: .55 } 50% { opacity: .9 } }`}</style>
    </>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid rgba(248,113,113,0.4)",
        background: "rgba(248,113,113,0.06)",
        borderRadius: 4,
        color: "#f87171",
        fontSize: 12,
        display: "flex", alignItems: "center", gap: 8,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        onClick={onRetry}
        style={{
          background: "none", border: "1px solid currentColor", borderRadius: 3,
          color: "inherit", cursor: "pointer", padding: "2px 8px", fontSize: 11,
        }}
      >
        {t("Retry")}
      </button>
    </div>
  );
}

function EmptyState() {
  const { t } = useI18n();
  return (
    <div style={{ padding: "16px 8px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6, textAlign: "center" }}>
      {t("No requests captured yet. Send a message in this session to record one.")}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function summarize(data: FetchedPayload): CapturedPayloadSummary {
  const requestJson = JSON.stringify(data.payload);
  const responseHeaders = data.response ? JSON.stringify(data.response.headers) : "";
  return {
    status: data.response?.status ?? null,
    durationMs: data.response ? data.response.timestamp - data.timestamp : null,
    requestSize: byteSize(requestJson),
    responseHeadersSize: data.response ? byteSize(responseHeaders) : 0,
  };
}

function byteSize(s: string): number {
  // Approximate UTF-8 byte length.
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  return s.length;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

const jsonPreStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontSize: 11,
  lineHeight: 1.45,
  color: "var(--text)",
  maxHeight: 320,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "var(--font-mono)",
};

/**
 * Build a cURL command from a captured request payload. Authorization
 * headers are masked with a placeholder — the full secret never leaves the
 * client.
 *
 * Best-effort: only fields pi-agent-core surfaces in `before_provider_request`
 * are available. We look for the most common endpoint / method / headers
 * fields in the payload; missing fields are silently omitted.
 */
function buildCurl(data: FetchedPayload): string {
  const payload = data.payload as { url?: unknown; endpoint?: unknown; method?: unknown; headers?: unknown; body?: unknown; messages?: unknown } | null;
  const url = (payload?.url ?? payload?.endpoint) as string | undefined;
  const method = (payload?.method as string | undefined) ?? "POST";
  const headers = (payload?.headers as Record<string, string> | undefined) ?? {};
  const body = payload?.body ?? (payload?.messages !== undefined ? payload : undefined);
  const bodyJson = body !== undefined ? JSON.stringify(body) : "";

  const parts: string[] = [`curl -X ${method}`];
  if (url) parts.push(`  ${shellQuote(url)}`);
  for (const [k, v] of Object.entries(headers)) {
    const value = /^(authorization|x-api-key|api-key|openai-api-key|anthropic-api-key)$/i.test(k)
      ? "***REDACTED***"
      : v;
    parts.push(`  -H ${shellQuote(`${k}: ${value}`)}`);
  }
  if (bodyJson) parts.push(`  --data ${shellQuote(bodyJson)}`);
  return parts.join(" \\\n");
}

function shellQuote(s: string): string {
  // Single-quote and escape embedded single quotes — POSIX-safe.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function copyCurl(data: FetchedPayload, toast: ReturnType<typeof useToast>, t: ReturnType<typeof useI18n>["t"]) {
  const curl = buildCurl(data);
  navigator.clipboard.writeText(curl).then(
    () => toast.show({ kind: "success", message: t("Copied") }),
    () => toast.show({ kind: "error", message: t("Copy failed") }),
  );
}
