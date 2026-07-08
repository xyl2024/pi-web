"use client";

import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";

type Level = "info" | "warn" | "error";

const LEVELS: readonly Level[] = ["info", "warn", "error"] as const;

const LEVEL_COLORS: Record<Level, string> = {
  info: "var(--text-muted)",
  warn: "#f59e0b",
  error: "#ef4444",
};

const LEVEL_LABELS: Record<Level, string> = {
  info: "info",
  warn: "warn",
  error: "error",
};

type LastSent =
  | { ok: true; ts: number; source: string; level: Level; title: string }
  | { ok: false; ts: number; error: string }
  | null;

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isValidHref(value: string): boolean {
  if (value.length === 0) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function InboxTestSection() {
  const { t } = useI18n();
  const toast = useToast();
  const [source, setSource] = useState("test");
  const [level, setLevel] = useState<Level>("info");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [href, setHref] = useState("");
  const [sending, setSending] = useState(false);
  const [lastSent, setLastSent] = useState<LastSent>(null);

  const hrefValid = useMemo(() => isValidHref(href.trim()), [href]);
  const sourceValid = source.trim().length > 0;
  const titleValid = title.trim().length > 0;
  const canSend = sourceValid && titleValid && hrefValid && !sending;

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    const trimmedBody = body.trim();
    const trimmedHref = href.trim();
    try {
      const res = await fetch("/api/inbox/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: source.trim(),
          level,
          title: title.trim(),
          ...(trimmedBody ? { body: trimmedBody } : {}),
          ...(trimmedHref ? { href: trimmedHref } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = data.error ?? `HTTP ${res.status}`;
        setLastSent({ ok: false, ts: Date.now(), error: msg });
        toast.show({ kind: "error", message: msg });
        return;
      }
      setLastSent({
        ok: true,
        ts: Date.now(),
        source: source.trim(),
        level,
        title: title.trim(),
      });
      toast.show({ kind: "success", message: t("Test message sent") });
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : t("Network error");
      setLastSent({ ok: false, ts: Date.now(), error: msg });
      toast.show({ kind: "error", message: msg });
    } finally {
      setSending(false);
    }
  }, [canSend, source, level, title, body, href, t, toast]);

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 4px 0" }}>
        {t("Inbox Test")}
      </h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px 0", lineHeight: 1.5 }}>
        {t("Push a synthetic message into the Inbox to preview the bell badge, list, and source chip. Real RSS / scheduler pushes are unchanged.")}
      </p>

      {/* Source */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 6px 0" }}>
        {t("Test source")}
      </div>
      <input
        type="text"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        maxLength={64}
        placeholder="test"
        style={inputStyle(!sourceValid)}
      />

      {/* Level chips */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "14px 0 6px 0" }}>
        {t("Test level")}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {LEVELS.map((lv) => {
          const selected = lv === level;
          const color = LEVEL_COLORS[lv];
          return (
            <button
              key={lv}
              onClick={() => setLevel(lv)}
              aria-pressed={selected}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                height: 30,
                background: selected ? "var(--bg-panel)" : "transparent",
                border: selected ? "2px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: 6,
                color: selected ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: selected ? 600 : 500,
                transition: "border-color 0.12s, color 0.12s, background 0.12s",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: color,
                  flexShrink: 0,
                }}
              />
              {LEVEL_LABELS[lv]}
            </button>
          );
        })}
      </div>

      {/* Title */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "14px 0 6px 0" }}>
        {t("Test title")}
      </div>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={300}
        placeholder={t("Test title placeholder")}
        style={inputStyle(!titleValid)}
      />

      {/* Body */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "14px 0 6px 0" }}>
        {t("Test body")} <span style={{ color: "var(--text-dim)" }}>({t("Test optional hint")})</span>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder={t("Test optional body hint")}
        style={{
          ...inputStyle(false),
          height: "auto",
          padding: "8px 10px",
          resize: "vertical",
          fontFamily: "var(--font-sans)",
          lineHeight: 1.5,
        }}
      />

      {/* Href */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "14px 0 6px 0" }}>
        {t("Test link URL")} <span style={{ color: "var(--text-dim)" }}>({t("Test optional hint")})</span>
      </div>
      <input
        type="text"
        value={href}
        onChange={(e) => setHref(e.target.value)}
        placeholder="https://example.com"
        style={inputStyle(!hrefValid)}
      />
      {!hrefValid && (
        <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>
          {t("Test must be a valid URL")}
        </div>
      )}

      {/* Send */}
      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            padding: "6px 16px",
            height: 32,
            background: canSend ? "var(--accent)" : "var(--bg-panel)",
            border: "none",
            borderRadius: 6,
            color: canSend ? "#fff" : "var(--text-muted)",
            cursor: canSend ? "pointer" : "default",
            fontSize: 13,
            fontWeight: 600,
            transition: "background 0.12s, color 0.12s",
          }}
        >
          {sending ? t("Test sending") : t("Test send")}
        </button>
        {lastSent && lastSent.ok && (
          <span style={{ fontSize: 12, color: "#16a34a", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            ✓ {formatClock(lastSent.ts)} · {lastSent.source} · {lastSent.level} · “{truncate(lastSent.title, 60)}”
          </span>
        )}
        {lastSent && !lastSent.ok && (
          <span style={{ fontSize: 12, color: "#ef4444", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            ✗ {formatClock(lastSent.ts)} · {lastSent.error}
          </span>
        )}
      </div>
    </div>
  );
}

function inputStyle(invalid: boolean): React.CSSProperties {
  return {
    width: "100%",
    height: 32,
    padding: "4px 10px",
    background: "var(--bg-panel)",
    border: invalid ? "1px solid #ef4444" : "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
