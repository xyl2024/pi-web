"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";

type Status =
  | { configured: false }
  | { configured: true; accountId: string; userId: string | null; baseUrl: string; savedAt: string };

type LoginInfo = {
  sessionKey: string;
  qrDataUrl: string;
  qrUrl: string;
  expiresAt: number;
};

type Contact = {
  userId: string;
  firstSeen: string;
  lastSeen: string;
  messageCount: number;
  lastMessagePreview: string;
  contextToken?: string;
};

type LoginPhase =
  | "waiting"
  | "scanned"
  | "verifying"
  | "verify_blocked"
  | "redirected"
  | "confirmed"
  | "already_bound"
  | "expired"
  | "error";

const PHASE_LABELS_EN: Record<LoginPhase, string> = {
  waiting: "Waiting for scan…",
  scanned: "Scanned, confirming…",
  verifying: "Enter the pairing code shown in WeChat",
  verify_blocked: "Too many wrong codes — refresh the QR",
  redirected: "Scanning on a different host, switching…",
  confirmed: "Connected",
  already_bound: "Already linked to this OpenClaw",
  expired: "QR expired",
  error: "Error",
};

const PHASE_LABELS_ZH: Record<LoginPhase, string> = {
  waiting: "等待扫码…",
  scanned: "已扫码，正在确认…",
  verifying: "请输入微信中显示的配对码",
  verify_blocked: "配对码错误次数过多，请刷新二维码",
  redirected: "正在切换到其他 IDC 节点…",
  confirmed: "已连接",
  already_bound: "此 OpenClaw 已绑定该微信账号",
  expired: "二维码已过期",
  error: "出错了",
};

export function WeChatPanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [login, setLogin] = useState<LoginInfo | null>(null);
  const [phase, setPhase] = useState<LoginPhase | null>(null);
  const [phaseMessage, setPhaseMessage] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState("");
  const [text, setText] = useState(t("Hello from pi-web!"));
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [monitorRunning, setMonitorRunning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/weixin/status");
    const data = (await res.json()) as Status;
    setStatus(data);
    if (data.configured) {
      // After login completes, stop polling.
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    }
  }, []);

  const refreshContacts = useCallback(async () => {
    if (!status?.configured) {
      setContacts([]);
      setMonitorRunning(false);
      return;
    }
    try {
      const res = await fetch("/api/weixin/contacts");
      if (!res.ok) return;
      const data = (await res.json()) as { contacts: Contact[]; monitorRunning: boolean };
      setContacts((prev) => {
        // Surface newly-arrived senders with a toast.
        const prevIds = new Set(prev.map((c) => c.userId));
        for (const c of data.contacts) {
          if (!prevIds.has(c.userId)) {
            const preview = c.lastMessagePreview || t("(no text)");
            toast.show({
              kind: "info",
              message: t("New contact: {userId}").replace("{userId}", c.userId) + ` — ${preview}`,
            });
          }
        }
        return data.contacts;
      });
      setMonitorRunning(data.monitorRunning);
    } catch {
      // ignore
    }
  }, [status, toast, t]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Poll login status while a login is in flight.
  useEffect(() => {
    if (!login || !login.sessionKey) return;
    if (status?.configured) return;
    if (phase === "confirmed" || phase === "already_bound" || phase === "expired" || phase === "error") return;

    const tick = async () => {
      try {
        const res = await fetch(`/api/weixin/login?sessionKey=${encodeURIComponent(login.sessionKey)}`);
        if (res.status === 410) {
          setPhase("expired");
          setPhaseMessage("Session expired. Please start a new login.");
          return;
        }
        const data = (await res.json()) as { phase: LoginPhase; message?: string; account?: { accountId: string } };
        setPhase(data.phase);
        if (data.message) setPhaseMessage(data.message);
        if (data.phase === "confirmed" || data.phase === "already_bound") {
          await refreshStatus();
          toast.show({ kind: "success", message: t("WeChat account linked") });
          return;
        }
      } catch {
        // ignore transient errors
      }
      pollRef.current = setTimeout(tick, 2000);
    };
    pollRef.current = setTimeout(tick, 2000);

    return () => {
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [login, phase, status, refreshStatus, toast, t]);

  // Poll contacts every 3s while logged in.
  useEffect(() => {
    if (!status?.configured) return;
    refreshContacts();
    const id = setInterval(refreshContacts, 3000);
    return () => clearInterval(id);
  }, [status?.configured, refreshContacts]);

  const startLogin = useCallback(async () => {
    setBusy(true);
    setPhase("waiting");
    setPhaseMessage(null);
    try {
      const res = await fetch("/api/weixin/login", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: "unknown" }))) as { error?: string };
        toast.show({ kind: "error", message: err.error || "Failed to start login" });
        return;
      }
      const data = (await res.json()) as LoginInfo;
      setLogin(data);
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const submitCode = useCallback(async () => {
    if (!login || !code.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/weixin/login/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey: login.sessionKey, code: code.trim() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: "unknown" }))) as { error?: string };
        toast.show({ kind: "error", message: err.error || "Failed to submit code" });
        return;
      }
      setCode("");
    } finally {
      setBusy(false);
    }
  }, [login, code, toast]);

  const doLogout = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/weixin/logout", { method: "POST" });
      setLogin(null);
      setPhase(null);
      setPhaseMessage(null);
      await refreshStatus();
      toast.show({ kind: "info", message: t("WeChat account logged out") });
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, toast, t]);

  const doSend = useCallback(async () => {
    if (!to.trim() || !text.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/weixin/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim(), text: text.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; messageId?: string; error?: string };
      if (!res.ok || !data.ok) {
        toast.show({ kind: "error", message: data.error || `HTTP ${res.status}` });
        return;
      }
      toast.show({ kind: "success", message: t("Message sent") });
    } catch (err) {
      toast.show({ kind: "error", message: String(err) });
    } finally {
      setBusy(false);
    }
  }, [to, text, toast, t]);

  const phaseLabel = phase ? (locale === "zh" ? PHASE_LABELS_ZH[phase] : PHASE_LABELS_EN[phase]) : null;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 520, maxWidth: "92vw", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("WeChat Demo")}</span>
            <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>ilinkai.weixin.qq.com</code>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 18, maxHeight: "70vh", overflowY: "auto" }}>

          {/* Status pill */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 4,
              background: status?.configured ? "var(--accent)" : "var(--text-muted)",
            }} />
            <span style={{ fontSize: 13, color: "var(--text)" }}>
              {status === null
                ? t("Loading…")
                : status.configured
                  ? t("Connected")
                  : t("Not logged in")}
            </span>
          </div>

          {/* Logged-in view */}
          {status?.configured && (
            <section style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("Account")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 13 }}>
                <span style={{ color: "var(--text-muted)" }}>accountId</span>
                <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{status.accountId}</code>
                <span style={{ color: "var(--text-muted)" }}>userId</span>
                <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{status.userId ?? "(none)"}</code>
                <span style={{ color: "var(--text-muted)" }}>baseUrl</span>
                <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontSize: 11 }}>{status.baseUrl}</code>
              </div>
            </section>
          )}

          {/* Test send form */}
          {status?.configured && (
            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>{t("Send a test message")}</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                {t("Enter the recipient's WeChat id (must end with @im.wechat) and a message body.")}
              </p>

              {contacts.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span>{t("Known contacts")} ({contacts.length})</span>
                    <span style={{ opacity: monitorRunning ? 1 : 0.5 }}>
                      {monitorRunning ? "● live" : "○ idle"}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 140, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
                    {contacts.map((c) => (
                      <button
                        key={c.userId}
                        onClick={() => setTo(c.userId)}
                        title={c.userId}
                        style={{
                          display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                          padding: "6px 10px", background: to === c.userId ? "var(--bg-hover)" : "transparent",
                          border: "none", borderBottom: "1px solid var(--border)", borderRadius: 0,
                          color: "var(--text)", fontSize: 12, textAlign: "left", cursor: "pointer",
                        }}
                      >
                        <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>{c.userId}</code>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                          {c.lastMessagePreview || t("(no text)")} · {c.messageCount}×
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, padding: "8px 10px", background: "var(--bg-panel)", border: "1px dashed var(--border)", borderRadius: 6, lineHeight: 1.5 }}>
                  {t("No contacts yet. Ask a friend to scan the QR above and send you a message — they'll appear here.")}
                </p>
              )}

              <input
                type="text"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="user-id@im.wechat"
                style={{ height: 32, padding: "4px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none" }}
              />
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                style={{ padding: "6px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={doSend}
                  disabled={busy || !to.trim() || !text.trim()}
                  style={{ padding: "6px 14px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: busy || !to.trim() || !text.trim() ? "not-allowed" : "pointer", opacity: busy || !to.trim() || !text.trim() ? 0.5 : 1 }}
                >
                  {t("Send")}
                </button>
                <button
                  onClick={doLogout}
                  disabled={busy}
                  style={{ padding: "6px 14px", background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, cursor: busy ? "not-allowed" : "pointer" }}
                >
                  {t("Log out")}
                </button>
              </div>
            </section>
          )}

          {/* Login flow */}
          {!status?.configured && (
            <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {!login && (
                <button
                  onClick={startLogin}
                  disabled={busy}
                  style={{ alignSelf: "flex-start", padding: "8px 16px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}
                >
                  {t("Start QR login")}
                </button>
              )}

              {login && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                  <div style={{ padding: 12, background: "#fff", borderRadius: 8, border: "1px solid var(--border)" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={login.qrDataUrl} alt="WeChat login QR" width={224} height={224} style={{ display: "block" }} />
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5, textAlign: "center" }}>
                    {t("Scan with WeChat, or open the URL on your phone:")}
                  </p>
                  <a
                    href={login.qrUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)", wordBreak: "break-all", textAlign: "center" }}
                  >
                    {login.qrUrl}
                  </a>

                  {phase && (
                    <div style={{ fontSize: 12, color: "var(--text)", padding: "4px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4 }}>
                      {phaseLabel}
                      {phaseMessage ? ` — ${phaseMessage}` : ""}
                    </div>
                  )}

                  {phase === "verifying" && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="text"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder={t("Pairing code")}
                        autoFocus
                        style={{ width: 120, height: 28, padding: "4px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none" }}
                      />
                      <button
                        onClick={submitCode}
                        disabled={busy || !code.trim()}
                        style={{ padding: "4px 12px", background: "var(--accent)", color: "var(--bg)", border: "none", borderRadius: 4, fontSize: 12, cursor: busy || !code.trim() ? "not-allowed" : "pointer", opacity: busy || !code.trim() ? 0.5 : 1 }}
                      >
                        {t("Submit")}
                      </button>
                    </div>
                  )}

                  {(phase === "expired" || phase === "error" || phase === "verify_blocked") && (
                    <button
                      onClick={() => { setLogin(null); setPhase(null); setPhaseMessage(null); startLogin(); }}
                      disabled={busy}
                      style={{ padding: "6px 14px", background: "transparent", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, cursor: busy ? "not-allowed" : "pointer" }}
                    >
                      {t("Refresh QR")}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

        </div>
      </div>
    </div>
  );
}
