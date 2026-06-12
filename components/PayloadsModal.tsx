"use client";

import { useCallback, useEffect, useState } from "react";
import { Tooltip } from "./Tooltip";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";

interface CapturedPayload {
  index: number;
  timestamp: number;
  payload: unknown;
  response?: {
    status: number;
    headers: Record<string, string>;
    timestamp: number;
  };
}

export function PayloadsModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [items, setItems] = useState<CapturedPayload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    setError(null);
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/payloads`)
      .then((r) => r.json())
      .then((d: { items?: CapturedPayload[] }) => setItems(d.items ?? []))
      .catch((e) => {
        setError(String(e));
        toast.show({ kind: "error", message: t("Failed to load payloads") });
      });
  }, [sessionId, t, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh on Esc + close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Copy failed") });
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 92vw)", maxHeight: "84vh",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 8, display: "flex", flexDirection: "column",
          fontFamily: "var(--font-mono)",
        }}
      >
        <div
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {t("Provider API Requests")}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {items ? `${items.length}` : ""}
          </span>
          <div style={{ flex: 1 }} />
          <Tooltip content={t("Refresh")}>
            <button
              onClick={load}
              style={{
                background: "none", border: "1px solid var(--border)", borderRadius: 4,
                color: "var(--text-muted)", cursor: "pointer", padding: "4px 8px", fontSize: 11,
              }}
            >
              {t("Refresh")}
            </button>
          </Tooltip>
          <button
            onClick={onClose}
            aria-label={t("Close")}
            style={{
              background: "none", border: "none", color: "var(--text-muted)",
              cursor: "pointer", padding: "2px 6px", fontSize: 18, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: "10px 14px", overflow: "auto" }}>
          {error && (
            <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>{error}</div>
          )}
          {!items && !error && (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("Loading...")}</div>
          )}
          {items && items.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
              {t("No requests captured yet. Send a message in this session to record one.")}
            </div>
          )}
          {items && items.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {items.map((entry) => {
                const isOpen = expanded.has(entry.index);
                const ts = new Date(entry.timestamp);
                const tsLabel = `${ts.toLocaleTimeString()}.${String(ts.getMilliseconds()).padStart(3, "0")}`;
                const statusColor = entry.response
                  ? entry.response.status >= 400
                    ? "#ef4444"
                    : entry.response.status >= 300
                      ? "rgba(234,179,8,0.95)"
                      : "#22c55e"
                  : "var(--text-dim)";
                const json = JSON.stringify(entry.payload, null, 2);
                return (
                  <div
                    key={entry.index}
                    style={{
                      border: "1px solid var(--border)", borderRadius: 4,
                      background: "var(--bg)",
                    }}
                  >
                    <button
                      onClick={() => toggle(entry.index)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 10,
                        padding: "6px 10px", background: "none", border: "none",
                        cursor: "pointer", color: "var(--text)", textAlign: "left",
                        fontFamily: "var(--font-mono)", fontSize: 11,
                      }}
                    >
                      <span style={{ color: "var(--text-dim)", width: 28 }}>#{entry.index}</span>
                      <span style={{ color: "var(--text-muted)" }}>{tsLabel}</span>
                      <span
                        style={{
                          color: statusColor, minWidth: 32,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {entry.response ? entry.response.status : "…"}
                      </span>
                      <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>
                        {isOpen ? t("Hide") : t("Show")}
                      </span>
                    </button>
                    {isOpen && (
                      <div style={{ borderTop: "1px solid var(--border)", padding: "8px 10px" }}>
                        <div
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            marginBottom: 6, fontSize: 11, color: "var(--text-muted)",
                          }}
                        >
                          <span>{t("Request payload")}</span>
                          <div style={{ flex: 1 }} />
                          <button
                            onClick={() => copy(json)}
                            style={{
                              background: "none", border: "1px solid var(--border)",
                              borderRadius: 4, color: "var(--text-muted)",
                              cursor: "pointer", padding: "2px 6px", fontSize: 10,
                            }}
                          >
                            {t("Copy")}
                          </button>
                        </div>
                        <pre
                          style={{
                            margin: 0, padding: 8, background: "var(--bg-panel)",
                            border: "1px solid var(--border)", borderRadius: 4,
                            fontSize: 11, lineHeight: 1.45, color: "var(--text)",
                            maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {json}
                        </pre>
                        {entry.response && (
                          <>
                            <div
                              style={{
                                display: "flex", alignItems: "center", gap: 8,
                                marginTop: 10, marginBottom: 6, fontSize: 11, color: "var(--text-muted)",
                              }}
                            >
                              <span>{t("Response headers")}</span>
                            </div>
                            <pre
                              style={{
                                margin: 0, padding: 8, background: "var(--bg-panel)",
                                border: "1px solid var(--border)", borderRadius: 4,
                                fontSize: 11, lineHeight: 1.45, color: "var(--text)",
                                maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                              }}
                            >
                              {JSON.stringify(entry.response.headers, null, 2)}
                            </pre>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "8px 14px", borderTop: "1px solid var(--border)",
            fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5,
          }}
        >
          {t("Persisted to ~/.pi-web/payloads/<sessionId>.jsonl. Captured via pi extension hooks; cleared only when the session is deleted.")}
        </div>
      </div>
    </div>
  );
}
