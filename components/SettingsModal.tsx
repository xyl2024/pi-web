"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme, PRESETS, PRESET_LABELS } from "@/hooks/useTheme";
import { useToast } from "./Toast";
import { WeChatSettingsSection } from "./WeChatSettingsSection";
import { InboxTestSection } from "./InboxTestSection";
import type { PiWebConfig, RightBarButtonId, RightSideBarConfig, AgentCustomToolName } from "@/lib/config";
import { setSettings } from "@/hooks/settingsStore";

// Display order for the "Right-side buttons" section checkboxes. Each row
// reuses an existing i18n key (originally written for the right-bar button
// tooltip) — one key per concept keeps the dictionary small.
const RIGHT_BAR_BUTTONS_UI: Array<{ id: RightBarButtonId; labelKey: string }> = [
  { id: "todos",     labelKey: "Open todos" },
  { id: "canvas",    labelKey: "Open canvas" },
  { id: "translate", labelKey: "Open translate" },
  { id: "json",      labelKey: "JSON" },
  { id: "rss",       labelKey: "RSS" },
  { id: "favorites", labelKey: "Open favorites" },
  { id: "tokens",    labelKey: "Open token audit" },
  { id: "toolCalls", labelKey: "Tool Calls" },
];

// Display order for the "Custom Tools" section checkboxes. Tools are
// registered on `createAgentSession` (see lib/rpc-manager.ts) and the
// enabled subset is sourced from `custom_tools.enabled` in
// ~/.pi-web/config.yaml. Toggling here writes the full PiWebConfig back
// via /api/settings — same immediate-apply pattern as Right-side buttons.
const CUSTOM_TOOLS_UI: Array<{ id: AgentCustomToolName; labelKey: string }> = [
  { id: "agent_todo", labelKey: "Agent Todo" },
  { id: "show_file",  labelKey: "Show File" },
];

export function SettingsModal({ onClose, onProfileSaved }: { onClose: () => void; onProfileSaved?: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const { preset, setPreset } = useTheme();
  const toast = useToast();
  const [config, setConfig] = useState<PiWebConfig | null>(null);
  const [profileUsername, setProfileUsername] = useState<string>("");
  const [originalUsername, setOriginalUsername] = useState<string>("");
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [avatarAttempt, setAvatarAttempt] = useState(0);
  const [hasAvatar, setHasAvatar] = useState(false);
  const [profileSavedOk, setProfileSavedOk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [originalConfig, setOriginalConfig] = useState<PiWebConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  // ── Append System Prompt (~/.pi/agent/APPEND_SYSTEM.md) ──
  const [appendSystem, setAppendSystem] = useState<{ content: string; path: string; exists: boolean } | null>(null);
  const [originalAppendSystem, setOriginalAppendSystem] = useState<string>("");
  const [appendSystemLoading, setAppendSystemLoading] = useState(true);
  const [appendSystemSaving, setAppendSystemSaving] = useState(false);
  const [appendSystemSavedOk, setAppendSystemSavedOk] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: PiWebConfig) => {
        setConfig(d);
        setOriginalConfig(d);
        setSettings(d); // publish to the store so AppShell reflects this snapshot
      })
      .catch(() => { /* error shown in body via fallback rendering */ })
      .finally(() => setLoading(false));
  }, []);

  // Load ~/.pi/agent/APPEND_SYSTEM.md (independent from main config save flow)
  useEffect(() => {
    let cancelled = false;
    fetch("/api/append-system")
      .then((r) => r.json())
      .then((d: { content?: string; path?: string; exists?: boolean; error?: string }) => {
        if (cancelled) return;
        if (d.error || typeof d.content !== "string" || typeof d.path !== "string") return;
        setAppendSystem({ content: d.content, path: d.path, exists: !!d.exists });
        setOriginalAppendSystem(d.content);
      })
      .catch(() => { /* leave empty: section shows a "not loaded" hint */ })
      .finally(() => { if (!cancelled) setAppendSystemLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Load profile (username + avatar presence) once on mount
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/profile");
        if (!res.ok) {
          if (!cancelled) setProfileUsername("");
          return;
        }
        const data = (await res.json()) as { username: string | null };
        if (cancelled) return;
        setProfileUsername(data.username ?? "");
        setOriginalUsername(data.username ?? "");
      } catch {
        if (!cancelled) setProfileUsername("");
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    };
    void load();
    // Probe avatar with HEAD-equivalent: use GET and read the response.
    // If the response is 200, the avatar exists; if 404, it does not.
    fetch("/api/profile/avatar", { method: "GET", cache: "no-store" })
      .then((r) => {
        if (!cancelled) setHasAvatar(r.ok);
        // Burn the body so the connection is released.
        if (r.ok) void r.arrayBuffer();
        else void r.text();
      })
      .catch(() => { if (!cancelled) setHasAvatar(false); });
    return () => { cancelled = true; };
  }, []);

  const profileDirty = profileUsername.trim() !== originalUsername || avatarRemoved;
  const profileCanSave = profileDirty && !profileSaving && !profileSavedOk;

  const handleProfileSave = useCallback(async () => {
    setProfileSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: profileUsername.trim() === "" ? null : profileUsername.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { username: string | null };
      const saved = data.username ?? "";
      setProfileUsername(saved);
      setOriginalUsername(saved);
      if (avatarRemoved) {
        setAvatarRemoved(false);
        setHasAvatar(false);
      }
      setProfileSavedOk(true);
      setTimeout(() => setProfileSavedOk(false), 1500);
      onProfileSaved?.();
      toast.show({ kind: "success", message: t("Profile saved") });
    } catch (e) {
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to save profile") });
    } finally {
      setProfileSaving(false);
    }
  }, [profileUsername, avatarRemoved, onProfileSaved, t, toast]);

  const handleAvatarFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (file.type !== "image/png") {
      toast.show({ kind: "error", message: t("Only PNG images are supported") });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.show({ kind: "error", message: t("File too large (max 5MB)") });
      return;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/profile/avatar", { method: "POST", body: form });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setHasAvatar(true);
      setAvatarAttempt((n) => n + 1);
      setAvatarRemoved(false);
      onProfileSaved?.();
      toast.show({ kind: "success", message: t("Avatar uploaded") });
    } catch (err) {
      toast.show({ kind: "error", message: err instanceof Error && err.message ? err.message : t("Failed to upload avatar") });
    }
  }, [onProfileSaved, t, toast]);

  const handleAvatarRemove = useCallback(async () => {
    try {
      const res = await fetch("/api/profile/avatar", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHasAvatar(false);
      setAvatarRemoved(true);
      setAvatarAttempt((n) => n + 1);
      onProfileSaved?.();
      toast.show({ kind: "success", message: t("Avatar removed") });
    } catch (err) {
      toast.show({ kind: "error", message: err instanceof Error && err.message ? err.message : t("Failed to remove avatar") });
    }
  }, [onProfileSaved, t, toast]);

  const handleClawdOnDeskToggle = useCallback(() => {
    setConfig((prev) => (prev ? {
      ...prev,
      extensions: {
        ...prev.extensions,
        clawd_on_desk: { enabled: !prev.extensions.clawd_on_desk.enabled },
      },
    } : prev));
  }, []);

  // Right-side button bar visibility — applies immediately on toggle (no
  // per-section Save button, unlike the Profile / Clawd / Append System
  // Prompt sections which have multi-step flows). Sets local config + the
  // global store + persists to /api/settings. Keeps `isDirty` false so the
  // modal's close-confirm prompt is not triggered by these toggles.
  const handleRightBarToggle = useCallback(async (id: RightBarButtonId) => {
    if (!config) return;
    const currentlyVisible = config.right_side_bar[id] !== false;
    const nextRightSideBar: RightSideBarConfig = {
      ...config.right_side_bar,
      [id]: !currentlyVisible,
    };
    const nextConfig: PiWebConfig = { ...config, right_side_bar: nextRightSideBar };
    setConfig(nextConfig);
    setOriginalConfig(nextConfig); // keep isDirty=false → no "discard changes?" prompt
    setSettings(nextConfig);       // publish → AppShell re-renders / auto-closes active panel
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.show({ kind: "success", message: t("Settings saved") });
    } catch (e) {
      toast.show({
        kind: "error",
        message: e instanceof Error && e.message ? e.message : t("Failed to save settings"),
      });
    }
  }, [config, t, toast]);

  // Custom tool enable/disable — same immediate-apply pattern as
  // handleRightBarToggle. Modifies the enabled array in-place and PUTs the
  // whole PiWebConfig back; the server's parseCustomTools validates and
  // silently drops unknown names on read. An empty `enabled` array is
  // honored as "disable everything" (the user pushed the buttons, we
  // trust them). Toggling here only affects sessions started AFTER the
  // PUT — running sessions keep the tool set they were created with
  // (createAgentSession freezes customTools).
  const handleCustomToolToggle = useCallback(async (id: AgentCustomToolName) => {
    if (!config) return;
    const isEnabled = config.custom_tools.enabled.includes(id);
    const nextEnabled: AgentCustomToolName[] = isEnabled
      ? config.custom_tools.enabled.filter((name) => name !== id)
      : [...config.custom_tools.enabled, id];
    const nextConfig: PiWebConfig = {
      ...config,
      custom_tools: { enabled: nextEnabled },
    };
    setConfig(nextConfig);
    setOriginalConfig(nextConfig);
    setSettings(nextConfig);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.show({ kind: "success", message: t("Settings saved") });
    } catch (e) {
      toast.show({
        kind: "error",
        message: e instanceof Error && e.message ? e.message : t("Failed to save settings"),
      });
    }
  }, [config, t, toast]);

  // APPEND_SYSTEM.md loader toggle. Same immediate-apply pattern as
  // handleRightBarToggle — PUTs the whole PiWebConfig and keeps isDirty
  // false so the modal's close-confirm prompt is not triggered. Changes
  // only take effect on sessions started AFTER the PUT (rpc-manager reads
  // the flag once per session start, same as clawd_on_desk / custom_tools).
  const handleAppendSystemEnabledToggle = useCallback(async () => {
    if (!config) return;
    const nextConfig: PiWebConfig = {
      ...config,
      append_system: { enabled: !config.append_system.enabled },
    };
    setConfig(nextConfig);
    setOriginalConfig(nextConfig);
    setSettings(nextConfig);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.show({ kind: "success", message: t("Settings saved") });
    } catch (e) {
      toast.show({
        kind: "error",
        message: e instanceof Error && e.message ? e.message : t("Failed to save settings"),
      });
    }
  }, [config, t, toast]);

  // Dirty check — compare current config against the snapshot from initial load
  const isDirty = !!config && !!originalConfig && JSON.stringify(config) !== JSON.stringify(originalConfig);

  const appendSystemDirty = !!appendSystem && appendSystem.content !== originalAppendSystem;

  const handleAppendSystemSave = useCallback(async () => {
    if (!appendSystem) return;
    setAppendSystemSaving(true);
    try {
      const res = await fetch("/api/append-system", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: appendSystem.content }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setOriginalAppendSystem(appendSystem.content);
      setAppendSystem((prev) => (prev ? { ...prev, exists: true } : prev));
      setAppendSystemSavedOk(true);
      setTimeout(() => setAppendSystemSavedOk(false), 1500);
      toast.show({ kind: "success", message: t("Append system prompt saved") });
    } catch (e) {
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to save append system prompt") });
    } finally {
      setAppendSystemSaving(false);
    }
  }, [appendSystem, t, toast]);

  const canSave = isDirty;

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOriginalConfig(config);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 1500);
      toast.show({ kind: "success", message: t("Settings saved") });
    } catch (e) {
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to save settings") });
    } finally {
      setSaving(false);
    }
  }, [config, t, toast]);

  // Intercept close: warn if there are unsaved changes
  const savedOkRef = useRef(savedOk);
  savedOkRef.current = savedOk;
  const handleClose = useCallback(() => {
    if (isDirty) {
      const ok = window.confirm(t("Discard unsaved changes?"));
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose, t]);

  const clawdOnDeskEnabled = config?.extensions.clawd_on_desk.enabled ?? false;

  if (loading) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
        <div style={{ width: 800, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
          {t("Loading...")}
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
        <div style={{ width: 800, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 40, textAlign: "center", color: "#ef4444" }}>
          {t("Failed to load settings")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div style={{ width: 800, height: "70vh", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("Settings")}</span>
          <button onClick={handleClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px" }}>
          {/* ── Section 0: Profile (avatar + username) ── */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>{t("Profile")}</h3>
              <button
                onClick={handleProfileSave}
                disabled={!profileCanSave}
                style={{
                  padding: "4px 14px", height: 28,
                  background: profileSavedOk ? "#16a34a" : profileSaving ? "var(--bg-panel)" : "var(--accent)",
                  border: "none", borderRadius: 6,
                  color: profileSavedOk ? "#fff" : profileSaving ? "var(--text-muted)" : "#fff",
                  cursor: profileCanSave ? "pointer" : "default",
                  fontSize: 12, fontWeight: 600,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                  transition: "background-color 0.2s ease, color 0.2s ease",
                  opacity: profileCanSave ? 1 : 0.5,
                }}
              >
                {profileSavedOk && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                <span>{profileSavedOk ? t("Saved") : profileSaving ? t("Saving...") : t("Save")}</span>
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px 0", lineHeight: 1.5 }}>
              {t("Avatar and display name shown at the bottom of the sidebar.")}
            </p>

            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 14 }}>
              <div
                style={{
                  width: 64, height: 64, flexShrink: 0,
                  borderRadius: "50%", overflow: "hidden",
                  background: "var(--bg-panel)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "1px solid var(--border)",
                  position: "relative",
                }}
              >
                {hasAvatar && !avatarRemoved ? (
                  <img
                    key={`preview-${avatarAttempt}`}
                    src={`/api/profile/avatar?k=${avatarAttempt}`}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    onError={() => setHasAvatar(false)}
                  />
                ) : (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)" }}>
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                )}
              </div>

              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png"
                  onChange={handleAvatarFileChange}
                  style={{ display: "none" }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    padding: "6px 12px", height: 32,
                    background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6,
                    color: "var(--text)", fontSize: 12, fontWeight: 500,
                    cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 6,
                    transition: "border-color 0.15s, color 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text)"; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  {t("Upload avatar")}
                </button>
                <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4 }}>
                  {t("PNG only · up to 5MB")}
                </span>
                {hasAvatar && !avatarRemoved && (
                  <button
                    onClick={handleAvatarRemove}
                    style={{
                      padding: "4px 10px", height: 26,
                      background: "none", border: "1px solid var(--border)", borderRadius: 6,
                      color: "var(--text-muted)", fontSize: 11,
                      cursor: "pointer",
                      transition: "color 0.15s, border-color 0.15s",
                      alignSelf: "flex-start",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "#ef4444"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; }}
                  >
                    {t("Remove avatar")}
                  </button>
                )}
              </div>
            </div>

            <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 6px 0" }}>{t("Username")}</div>
            <input
              type="text"
              placeholder={t("Your display name")}
              value={profileUsername}
              onChange={(e) => setProfileUsername(e.target.value)}
              disabled={profileLoading}
              maxLength={64}
              style={{
                width: "100%", height: 32, padding: "4px 10px",
                background: "var(--bg-panel)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text)", fontSize: 13,
                outline: "none",
              }}
            />
          </div>

          {/* ── Section 1: Appearance (theme + language, applied immediately) ── */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 12px 0" }}>{t("Appearance")}</h3>

            {/* Theme swatches */}
            <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px 0" }}>{t("Theme")}</div>
            <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={(e: React.MouseEvent) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setPreset(p, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                  }}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6,
                    padding: 0, background: "none", border: "none", cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      width: 100, height: 60, borderRadius: 8,
                      border: preset === p ? "2px solid var(--accent)" : "2px solid var(--border)",
                      background: p === "default"
                        ? "linear-gradient(135deg, #fafafa 50%, #6366f1 50%)"
                        : p === "midnight"
                        ? "linear-gradient(135deg, #0f172a 50%, #818cf8 50%)"
                        : p === "synthwave"
                        ? "linear-gradient(135deg, #1e1b4b 50%, #f472b6 50%)"
                        : p === "forest"
                        ? "linear-gradient(135deg, #f0fdf4 50%, #16a34a 50%)"
                        : "linear-gradient(135deg, #fdf6e3 50%, #b45309 50%)",
                      transition: "border-color 0.15s",
                    }}
                  />
                  <div style={{
                    fontSize: 11, textAlign: "center",
                    color: preset === p ? "var(--accent)" : "var(--text-muted)",
                    fontWeight: preset === p ? 600 : 400,
                  }}>
                    {PRESET_LABELS[p][locale]}
                  </div>
                </button>
              ))}
            </div>

            {/* Language buttons */}
            <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px 0" }}>{t("Language")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setLocale("en")}
                style={{
                  flex: 1, height: 36,
                  background: locale === "en" ? "var(--accent)" : "var(--bg-panel)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  color: locale === "en" ? "#fff" : "var(--text)",
                  cursor: "pointer", fontSize: 13, fontWeight: locale === "en" ? 600 : 500,
                  transition: "background-color 0.15s, color 0.15s",
                }}
              >
                {t("English")}
              </button>
              <button
                onClick={() => setLocale("zh")}
                style={{
                  flex: 1, height: 36,
                  background: locale === "zh" ? "var(--accent)" : "var(--bg-panel)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  color: locale === "zh" ? "#fff" : "var(--text)",
                  cursor: "pointer", fontSize: 13, fontWeight: locale === "zh" ? 600 : 500,
                  transition: "background-color 0.15s, color 0.15s",
                }}
              >
                {t("Chinese")}
              </button>
            </div>
          </div>

          {/* ── Section 2: WeChat Connection ── */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 4px 0" }}>{t("WeChat Connection")}</h3>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px 0", lineHeight: 1.5 }}>
              {t("Manage WeChat connection.")}
            </p>
            <WeChatSettingsSection />
          </div>

          {/* ── Section 3: Append System Prompt (~/.pi/agent/APPEND_SYSTEM.md) ── */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>{t("Append System Prompt")}</h3>
              <button
                onClick={handleAppendSystemSave}
                disabled={!appendSystemDirty || appendSystemSaving || appendSystemSavedOk}
                style={{
                  padding: "4px 14px", height: 28,
                  background: appendSystemSavedOk ? "#16a34a" : appendSystemSaving ? "var(--bg-panel)" : "var(--accent)",
                  border: "none", borderRadius: 6,
                  color: appendSystemSavedOk ? "#fff" : appendSystemSaving ? "var(--text-muted)" : "#fff",
                  cursor: (!appendSystemDirty || appendSystemSaving || appendSystemSavedOk) ? "default" : "pointer",
                  fontSize: 12, fontWeight: 600,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                  transition: "background-color 0.2s ease, color 0.2s ease",
                  opacity: (!appendSystemDirty || appendSystemSaving || appendSystemSavedOk) ? 0.5 : 1,
                }}
              >
                {appendSystemSavedOk && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                <span>{appendSystemSavedOk ? t("Saved") : appendSystemSaving ? t("Saving...") : t("Save")}</span>
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px 0", lineHeight: 1.5 }}>
              {config?.append_system.enabled
                ? t("Appended to every new pi session's system prompt. Takes effect on new sessions.")
                : t("Disabled — new sessions will NOT load this file. Edit and save above to keep the content for when you re-enable it.")}
            </p>
            {/* APPEND_SYSTEM.md loader toggle — immediate-apply. Independent
                from the Save button above (which only writes file content).
                Mirrors the styling of the Clawd on Desk switch in Section 4. */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: "var(--text)" }}>
                {config?.append_system.enabled ? t("Loading on") : t("Loading off")}
              </span>
              <button
                onClick={handleAppendSystemEnabledToggle}
                style={{
                  width: 40, height: 22, borderRadius: 11,
                  background: config?.append_system.enabled ? "var(--accent)" : "var(--bg-hover)",
                  border: "none", cursor: "pointer", position: "relative",
                  transition: "background 0.2s",
                }}
              >
                <span style={{
                  position: "absolute", top: 2,
                  left: config?.append_system.enabled ? 20 : 2,
                  width: 18, height: 18, borderRadius: 9,
                  background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  transition: "left 0.2s",
                }} />
              </button>
            </div>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)",
              padding: "4px 8px", marginBottom: 10,
              background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {appendSystem?.path ?? "~/.pi/agent/APPEND_SYSTEM.md"}
              {appendSystem && !appendSystem.exists && (
                <span style={{ marginLeft: 8, color: "var(--text-dim)" }}>({t("file does not exist yet — saving will create it")})</span>
              )}
            </div>
            <textarea
              value={appendSystem?.content ?? ""}
              onChange={(e) => setAppendSystem((prev) => (prev ? { ...prev, content: e.target.value } : prev))}
              disabled={appendSystemLoading || !appendSystem}
              placeholder={appendSystemLoading ? t("Loading...") : t("Markdown content appended after the built-in system prompt.")}
              spellCheck={false}
              style={{
                width: "100%", height: 220, padding: "10px 12px", resize: "vertical",
                background: "var(--bg-panel)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text)", fontSize: 12,
                fontFamily: "var(--font-mono)", lineHeight: 1.55,
                outline: "none",
              }}
            />
          </div>

          {/* ── Section 4: Built-in Extensions ── */}
          <div style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>{t("Clawd on Desk")}</h3>
              <button
                onClick={handleSave}
                disabled={!canSave || saving || savedOk}
                style={{
                  padding: "4px 14px", height: 28,
                  background: savedOk ? "#16a34a" : saving ? "var(--bg-panel)" : "var(--accent)",
                  border: "none", borderRadius: 6,
                  color: savedOk ? "#fff" : saving ? "var(--text-muted)" : "#fff",
                  cursor: (!canSave || saving || savedOk) ? "default" : "pointer",
                  fontSize: 12, fontWeight: 600,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                  transition: "background-color 0.2s ease, color 0.2s ease",
                }}
              >
                {savedOk && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                <span>{savedOk ? t("Saved") : saving ? t("Saving...") : t("Save")}</span>
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px 0", lineHeight: 1.5 }}>
              {t("Stream session events to a local Clawd desktop server (127.0.0.1:23333-23337). Useful for driving a desktop agent UI. Changes take effect on new sessions.")}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--text)" }}>{t("Enable Clawd on Desk")}</span>
              <button
                onClick={handleClawdOnDeskToggle}
                style={{
                  width: 40, height: 22, borderRadius: 11,
                  background: clawdOnDeskEnabled ? "var(--accent)" : "var(--bg-hover)",
                  border: "none", cursor: "pointer", position: "relative",
                  transition: "background 0.2s",
                }}
              >
                <span style={{
                  position: "absolute", top: 2, left: clawdOnDeskEnabled ? 20 : 2,
                  width: 18, height: 18, borderRadius: 9,
                  background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  transition: "left 0.2s",
                }} />
              </button>
            </div>
          </div>

          {/* ── Section 5: Custom Tools (agent_todo, show_file) ── */}
          {/* Immediate-apply checkboxes, same shape as Section 6. */}
          {config && (
            <div style={{ marginBottom: 24, marginTop: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 4px 0" }}>
                {t("Custom Tools")}
              </h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px 0", lineHeight: 1.5 }}>
                {t("Enable or disable custom pi tools. Changes apply to sessions started after this point; running sessions keep their original tool set.")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {CUSTOM_TOOLS_UI.map(({ id, labelKey }) => {
                  const checked = config.custom_tools.enabled.includes(id);
                  return (
                    <label
                      key={id}
                      style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, color: "var(--text)" }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleCustomToolToggle(id)}
                        style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
                      />
                      <span>{t(labelKey)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Section 6: Right-side buttons ── */}
          {/* Immediate-apply section (no per-section Save button). Each
              checkbox toggle calls handleRightBarToggle, which updates local
              state + the global settings store + PUTs to /api/settings. */}
          {config && (
            <div style={{ marginBottom: 24, marginTop: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 4px 0" }}>
                {t("Right-side buttons")}
              </h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px 0", lineHeight: 1.5 }}>
                {t("Choose which buttons appear in the right-side bar. Hidden buttons can still be opened from the command palette. Changes apply immediately.")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {RIGHT_BAR_BUTTONS_UI.map(({ id, labelKey }) => {
                  const checked = config.right_side_bar[id] !== false;
                  return (
                    <label
                      key={id}
                      style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, color: "var(--text)" }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleRightBarToggle(id)}
                        style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
                      />
                      <span>{t(labelKey)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <InboxTestSection />
        </div>
      </div>
    </div>
  );
}
