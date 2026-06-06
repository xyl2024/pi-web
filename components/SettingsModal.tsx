"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Tooltip } from "./Tooltip";
import { useI18n } from "@/hooks/useI18n";
import { WeChatSettingsSection } from "./WeChatSettingsSection";
import type { PiWebConfig } from "@/lib/config";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<PiWebConfig | null>(null);
  const [originalConfig, setOriginalConfig] = useState<PiWebConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: PiWebConfig) => {
        setConfig(d);
        setOriginalConfig(d);
      })
      .catch(() => { /* error shown in body via fallback rendering */ })
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = useCallback(() => {
    if (!config) return;
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            system_prompt_replacements: {
              ...prev.system_prompt_replacements,
              enabled: !prev.system_prompt_replacements.enabled,
            },
          }
        : prev
    );
  }, [config]);

  const handleRuleChange = useCallback(
    (index: number, field: "search" | "replace", value: string) => {
      if (!config) return;
      setConfig((prev) => {
        if (!prev) return prev;
        const rules = [...prev.system_prompt_replacements.rules];
        rules[index] = { ...rules[index], [field]: value };
        return {
          ...prev,
          system_prompt_replacements: { ...prev.system_prompt_replacements, rules },
        };
      });
    },
    [config]
  );

  const handleAddRule = useCallback(() => {
    if (!config) return;
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        system_prompt_replacements: {
          ...prev.system_prompt_replacements,
          rules: [...prev.system_prompt_replacements.rules, { search: "", replace: "" }],
        },
      };
    });
  }, [config]);

  const handleDeleteRule = useCallback(
    (index: number) => {
      if (!config) return;
      setConfig((prev) => {
        if (!prev) return prev;
        const rules = prev.system_prompt_replacements.rules.filter((_, i) => i !== index);
        return {
          ...prev,
          system_prompt_replacements: { ...prev.system_prompt_replacements, rules },
        };
      });
    },
    [config]
  );

  // Dirty check — compare current config against the snapshot from initial load
  const isDirty = !!config && !!originalConfig && JSON.stringify(config) !== JSON.stringify(originalConfig);

  const canSave = isDirty && config && config.system_prompt_replacements.rules.every(
    (r) => r.search.length > 0 && r.replace.length > 0
  );

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
    } catch {
      // Failure is conveyed by the button staying in non-Saved state
    } finally {
      setSaving(false);
    }
  }, [config]);

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

  const rules = config?.system_prompt_replacements.rules ?? [];
  const enabled = config?.system_prompt_replacements.enabled ?? false;

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
          {/* ── Section 1: System Prompt Replacements ── */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>{t("System Prompt Replacements")}</h3>
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
              {t("Replace literal strings in the system prompt. Changes take effect on new sessions. Existing sessions are unaffected.")}
            </p>

            {/* Toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{ fontSize: 13, color: "var(--text)" }}>{t("Enable replacements")}</span>
              <button
                onClick={handleToggle}
                style={{
                  width: 40, height: 22, borderRadius: 11,
                  background: enabled ? "var(--accent)" : "var(--bg-hover)",
                  border: "none", cursor: "pointer", position: "relative",
                  transition: "background 0.2s",
                }}
              >
                <span style={{
                  position: "absolute", top: 2, left: enabled ? 20 : 2,
                  width: 18, height: 18, borderRadius: 9,
                  background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  transition: "left 0.2s",
                }} />
              </button>
            </div>

            {/* Rules */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rules.map((rule, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="text"
                    placeholder={t("search")}
                    value={rule.search}
                    onChange={(e) => handleRuleChange(idx, "search", e.target.value)}
                    style={{
                      flex: 1, height: 32, padding: "4px 10px",
                      background: "var(--bg-panel)", border: "1px solid var(--border)",
                      borderRadius: 6, color: "var(--text)", fontSize: 13,
                      outline: "none",
                    }}
                  />
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>→</span>
                  <input
                    type="text"
                    placeholder={t("replace")}
                    value={rule.replace}
                    onChange={(e) => handleRuleChange(idx, "replace", e.target.value)}
                    style={{
                      flex: 1, height: 32, padding: "4px 10px",
                      background: "var(--bg-panel)", border: "1px solid var(--border)",
                      borderRadius: 6, color: "var(--text)", fontSize: 13,
                      outline: "none",
                    }}
                  />
                  <Tooltip content={t("Delete rule")}>
                    <button
                      onClick={() => handleDeleteRule(idx)}
                      style={{
                        width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                        background: "none", border: "none", borderRadius: 5, color: "var(--text-muted)",
                        cursor: "pointer", fontSize: 14,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "#ef4444"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                    >
                      ×
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>

            {/* Add rule button */}
            <button
              onClick={handleAddRule}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                marginTop: 10, padding: "4px 12px", height: 28,
                background: "var(--bg-panel)", border: "1px dashed var(--border)",
                borderRadius: 6, color: "var(--text-muted)", fontSize: 12,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              {t("+ Add rule")}
            </button>
          </div>

          {/* ── Section 2: WeChat Connection ── */}
          <div style={{ marginBottom: 0 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 4px 0" }}>{t("WeChat Connection")}</h3>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px 0", lineHeight: 1.5 }}>
              {t("Manage WeChat connection.")}
            </p>
            <WeChatSettingsSection />
          </div>
        </div>
      </div>
    </div>
  );
}
