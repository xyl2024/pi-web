"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";

type Status =
  | { configured: false }
  | { configured: true; accountId: string; userId: string | null; baseUrl: string; savedAt: string; status?: "ok" | "expired" };

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

type WorkspaceInfo = {
  currentWorkspaceId: string | null;
  currentSessionId: string | null;
  pinnedCwds: string[];
  recentCwds: string[];
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

function shortenPath(p: string, max = 36): string {
  if (p.length <= max) return p;
  return "…" + p.slice(p.length - max + 1);
}

export function WeChatPanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [login, setLogin] = useState<LoginInfo | null>(null);
  const [phase, setPhase] = useState<LoginPhase | null>(null);
  const [phaseMessage, setPhaseMessage] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  // Track contact ids we've already toasted about, so the diff between
  // "previous poll" and "this poll" can be computed in a pure function
  // and the toast side-effect runs *outside* the setState updater
  // (which would otherwise trip React's "setState during render" rule).
  const knownContactIdsRef = useRef<Set<string>>(new Set());

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/weixin/status");
    const data = (await res.json()) as Status;
    setStatus(data);
    if (data.configured) {
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    if (!status?.configured) {
      setWorkspace(null);
      return;
    }
    try {
      const res = await fetch("/api/weixin/workspace");
      if (!res.ok) return;
      const data = (await res.json()) as WorkspaceInfo;
      setWorkspace(data);
    } catch {
      // ignore
    }
  }, [status?.configured]);

  const refreshContacts = useCallback(async () => {
    if (!status?.configured) {
      setContacts([]);
      setMonitorRunning(false);
      knownContactIdsRef.current = new Set();
      return;
    }
    try {
      const res = await fetch("/api/weixin/contacts");
      if (!res.ok) return;
      const data = (await res.json()) as { contacts: Contact[]; monitorRunning: boolean };
      // Toast for newly-arrived senders, but do it *outside* setState so
      // we don't trigger "setState during render" warnings.
      for (const c of data.contacts) {
        if (!knownContactIdsRef.current.has(c.userId)) {
          const preview = c.lastMessagePreview || t("(no text)");
          toast.show({
            kind: "info",
            message: t("New contact: {userId}").replace("{userId}", c.userId) + ` — ${preview}`,
          });
        }
      }
      knownContactIdsRef.current = new Set(data.contacts.map((c) => c.userId));
      setContacts(data.contacts);
      setMonitorRunning(data.monitorRunning);
    } catch {
      // ignore
    }
  }, [status, toast, t]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!status?.configured) return;
    refreshWorkspace();
    const id = setInterval(refreshWorkspace, 5000);
    return () => clearInterval(id);
  }, [status?.configured, refreshWorkspace]);

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

  useEffect(() => {
    if (!status?.configured) return;
    refreshContacts();
    const id = setInterval(refreshContacts, 3000);
    return () => clearInterval(id);
  }, [status?.configured, refreshContacts]);

  // Close workspace menu on outside click
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [workspaceMenuOpen]);

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

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    setWorkspaceMenuOpen(false);
    try {
      const res = await fetch("/api/weixin/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) {
        toast.show({ kind: "error", message: `Failed: HTTP ${res.status}` });
        return;
      }
      await refreshWorkspace();
      toast.show({ kind: "info", message: t("Workspace switched") });
    } catch (err) {
      toast.show({ kind: "error", message: String(err) });
    }
  }, [refreshWorkspace, toast, t]);

  const phaseLabel = phase ? (locale === "zh" ? PHASE_LABELS_ZH[phase] : PHASE_LABELS_EN[phase]) : null;
  const isExpired = status?.configured && status.status === "expired";

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
              background: isExpired ? "#ef4444" : status?.configured ? "var(--accent)" : "var(--text-muted)",
            }} />
            <span style={{ fontSize: 13, color: "var(--text)" }}>
              {status === null
                ? t("Loading…")
                : isExpired
                  ? t("Account expired — please scan again")
                  : status.configured
                    ? t("Connected")
                    : t("Not logged in")}
            </span>
          </div>

          {/* Expired banner */}
          {isExpired && (
            <section style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, border: "1px solid #ef4444", borderRadius: 8, background: "rgba(239,68,68,0.06)" }}>
              <div style={{ fontSize: 12, color: "#ef4444" }}>
                {t("Account expired — please scan again")}
              </div>
              <button
                onClick={doLogout}
                style={{ alignSelf: "flex-start", padding: "6px 14px", background: "transparent", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, cursor: "pointer" }}
              >
                {t("Log out")}
              </button>
            </section>
          )}

          {/* Logged-in view */}
          {status?.configured && !isExpired && (
            <>
              {/* Top status bar (U2): workspace + session */}
              <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
                <div ref={workspaceMenuRef} style={{ position: "relative" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{t("Current workspace")}:</span>
                    <button
                      onClick={() => setWorkspaceMenuOpen((v) => !v)}
                      style={{
                        flex: 1, minWidth: 0,
                        background: "none", border: "none", padding: 0,
                        color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)",
                        textAlign: "left", cursor: "pointer",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      {workspace?.currentWorkspaceId
                        ? shortenPath(workspace.currentWorkspaceId)
                        : t("Not set")}
                    </button>
                    <button
                      onClick={() => setWorkspaceMenuOpen((v) => !v)}
                      title={t("Switch workspace")}
                      style={{
                        background: "var(--bg-hover)", border: "1px solid var(--border)",
                        color: "var(--text-muted)", borderRadius: 5, padding: "2px 8px",
                        fontSize: 11, cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      {t("Switch workspace")}
                    </button>
                  </div>
                  {workspaceMenuOpen && (
                    <div
                      style={{
                        position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10, marginTop: 4,
                        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
                        boxShadow: "0 4px 16px rgba(0,0,0,0.15)", maxHeight: 240, overflowY: "auto",
                      }}
                    >
                      {!workspace || (workspace.pinnedCwds.length === 0 && workspace.recentCwds.length === 0) ? (
                        <div style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}>
                          {t("No workspaces yet")}
                        </div>
                      ) : (
                        <>
                          {workspace.pinnedCwds.length > 0 && (
                            <>
                              <div style={{ padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>
                                {t("Pinned")}
                              </div>
                              {workspace.pinnedCwds.map((cwd) => (
                                <button
                                  key={`p-${cwd}`}
                                  onClick={() => switchWorkspace(cwd)}
                                  title={cwd}
                                  style={{
                                    display: "block", width: "100%",
                                    padding: "6px 10px", background: cwd === workspace.currentWorkspaceId ? "var(--bg-selected)" : "none",
                                    border: "none", textAlign: "left", cursor: "pointer",
                                    color: cwd === workspace.currentWorkspaceId ? "var(--text)" : "var(--text-muted)",
                                    fontSize: 11, fontFamily: "var(--font-mono)",
                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  }}
                                >
                                  {shortenPath(cwd, 40)}
                                </button>
                              ))}
                            </>
                          )}
                          {workspace.recentCwds.length > 0 && (
                            <>
                              <div style={{ padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", borderTop: workspace.pinnedCwds.length > 0 ? "1px solid var(--border)" : "none" }}>
                                {t("Recent")}
                              </div>
                              {workspace.recentCwds.map((cwd) => (
                                <button
                                  key={`r-${cwd}`}
                                  onClick={() => switchWorkspace(cwd)}
                                  title={cwd}
                                  style={{
                                    display: "block", width: "100%",
                                    padding: "6px 10px", background: cwd === workspace.currentWorkspaceId ? "var(--bg-selected)" : "none",
                                    border: "none", textAlign: "left", cursor: "pointer",
                                    color: cwd === workspace.currentWorkspaceId ? "var(--text)" : "var(--text-muted)",
                                    fontSize: 11, fontFamily: "var(--font-mono)",
                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  }}
                                >
                                  {shortenPath(cwd, 40)}
                                </button>
                              ))}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{t("Current session")}:</span>
                  <code style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {workspace?.currentSessionId
                      ? workspace.currentSessionId.slice(0, 8) + "…"
                      : t("Not started")}
                  </code>
                </div>
              </section>

              {/* Account info (collapsed — most info now in the status bar) */}
              <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("Account")}</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 11 }}>
                  <span style={{ color: "var(--text-muted)" }}>userId</span>
                  <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{status.userId ?? "(none)"}</code>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button
                    onClick={doLogout}
                    disabled={busy}
                    style={{ padding: "4px 12px", background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 11, cursor: busy ? "not-allowed" : "pointer" }}
                  >
                    {t("Log out")}
                  </button>
                </div>
              </section>

              {/* Contacts (read-only) */}
              <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span>{t("Known contacts")}{contacts.length > 0 ? ` (${contacts.length})` : ""}</span>
                  <span style={{ opacity: monitorRunning ? 1 : 0.5 }}>
                    {monitorRunning ? "● live" : "○ idle"}
                  </span>
                </div>
                {contacts.length === 0 ? (
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, padding: "8px 10px", background: "var(--bg-panel)", border: "1px dashed var(--border)", borderRadius: 6, lineHeight: 1.5 }}>
                    {t("No contacts yet. Ask a friend to scan the QR above and send you a message — they'll appear here.")}
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 160, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
                    {contacts.map((c) => (
                      <div
                        key={c.userId}
                        title={c.userId}
                        style={{
                          display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
                          padding: "5px 10px", borderBottom: "1px solid var(--border)",
                          color: "var(--text)", fontSize: 11,
                        }}
                      >
                        <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>{c.userId}</code>
                        <span style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                          {c.lastMessagePreview || t("(no text)")} · {c.messageCount}×
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
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
