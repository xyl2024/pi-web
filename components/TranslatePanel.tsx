"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { ProviderIcon } from "./ProviderIcon";
import {
  DEFAULT_TARGET_LANGUAGE,
  SUPPORTED_LANGUAGES,
  TRANSLATE_PROMPTS,
  isLanguageCode,
  type LanguageCode,
} from "@/lib/translate";

const STATE_STORAGE_KEY = "pi-translate-state";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface ModelsApiResponse {
  modelList?: ModelInfo[];
  models?: Record<string, string>;
  defaultModel?: { provider: string; modelId: string } | null;
}

interface PersistedState {
  input?: string;
  output?: string;
  model?: { provider: string; modelId: string };
  target?: LanguageCode;
}

export function TranslatePanel() {
  const { t } = useI18n();
  const toast = useToast();

  const [modelList, setModelList] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [targetDropdownOpen, setTargetDropdownOpen] = useState(false);
  const [targetDropdownRect, setTargetDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const targetDropdownRef = useRef<HTMLDivElement | null>(null);
  const targetPanelRef = useRef<HTMLDivElement | null>(null);

  const [target, setTarget] = useState<LanguageCode>(DEFAULT_TARGET_LANGUAGE);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [hoveredAction, setHoveredAction] = useState<"prompts" | "copy" | "clear" | null>(null);

  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  // Persistence refs (not in state — changes here should not trigger renders).
  // `savedModelRef` holds the model the user previously selected; the models
  // fetch effect consults it once the model list is available so we restore
  // the same model instead of falling back to the default.
  const savedModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  // `initializedRef` gates the save effect so the very first run (with
  // pre-restore default values) doesn't clobber the data we're about to
  // rehydrate.
  const initializedRef = useRef(false);

  // Restore input/output/model/target from localStorage so switching tabs (or
  // closing/reopening the translate tab) preserves the last translation.
  // Translation now fires only when the user clicks the Translate button, so
  // rehydrating these values doesn't kick off a request on its own.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STATE_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as PersistedState;
      if (typeof data?.input === "string") setInput(data.input);
      if (typeof data?.output === "string") setOutput(data.output);
      if (data?.model && typeof data.model.provider === "string" && typeof data.model.modelId === "string") {
        savedModelRef.current = { provider: data.model.provider, modelId: data.model.modelId };
      }
      if (isLanguageCode(data?.target)) {
        setTarget(data.target);
      }
    } catch { /* malformed JSON or localStorage unavailable — ignore */ }
  }, []);

  // Persist input/output/model/target to localStorage on every change. The
  // first run is skipped so the initial empty state doesn't overwrite the
  // data we are about to rehydrate above.
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    try {
      const payload: PersistedState = { input, output, target };
      if (model) payload.model = model;
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(payload));
    } catch { /* quota exceeded or localStorage unavailable — ignore */ }
  }, [input, output, model, target]);

  // Load models on mount, pre-select the default.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ModelsApiResponse;
        if (cancelled) return;
        const list = data.modelList ?? [];
        setModelList(list);
        // Prefer the model the user had selected last session; fall back to
        // the default model, then to the first entry in the list.
        const saved = savedModelRef.current;
        if (saved && list.some((m) => m.provider === saved.provider && m.id === saved.modelId)) {
          setModel(saved);
        } else if (data.defaultModel) {
          setModel(data.defaultModel);
        } else if (list.length > 0) {
          setModel({ provider: list[0].provider, modelId: list[0].id });
        }
      } catch (e) {
        if (!cancelled) toast.show({ kind: "error", message: e instanceof Error ? e.message : t("Translation failed") });
      }
    })();
    return () => { cancelled = true; };
  }, [toast, t]);

  // Close model / target dropdowns on outside click.
  useEffect(() => {
    if (!modelDropdownOpen && !targetDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (modelDropdownOpen) {
        if (dropdownRef.current?.contains(tgt)) return;
        if (panelRef.current?.contains(tgt)) return;
        setModelDropdownOpen(false);
      }
      if (targetDropdownOpen) {
        if (targetDropdownRef.current?.contains(tgt)) return;
        if (targetPanelRef.current?.contains(tgt)) return;
        setTargetDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelDropdownOpen, targetDropdownOpen]);

  // No auto-resize needed: the input wrapper is `flex: 1`, so the textarea
  // fills half the panel vertically (matching the output area 1:1) and
  // scrolls internally when content overflows.

  // Auto-scroll output to the bottom while streaming.
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [output]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  const runTranslation = useCallback(async (text: string) => {
    if (!model) return;
    // Replace any in-flight request.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setOutput("");
    setError(null);
    setIsStreaming(true);

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          provider: model.provider,
          modelId: model.modelId,
          target,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${errText ? `: ${errText}` : ""}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let payload: { type?: string; text?: string; message?: string };
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }
          if (payload.type === "delta" && typeof payload.text === "string") {
            setOutput((o) => o + payload.text!);
          } else if (payload.type === "error") {
            throw new Error(payload.message || t("Translation failed"));
          }
          // "done" → loop exits on next read returning done.
        }
      }
      // Strip leading/trailing whitespace (spaces, tabs, newlines) from the
      // final accumulated translation. Models frequently pad the response
      // with surrounding newlines; without this, the user sees a blank line
      // before/after the actual translation.
      setOutput((o) => o.trim());
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.show({ kind: "error", message: msg || t("Translation failed") });
    } finally {
      // Only reset if we're still the active controller — a newer
      // translation may have taken over while we were unwinding.
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setIsStreaming(false);
      }
    }
  }, [model, target, toast, t]);

  // Translation fires only when the user clicks the Translate button (or hits
  // Cmd/Ctrl+Enter). handleTranslate doubles as Stop while a request is
  // in-flight so the same button covers both states.

  const handleTranslate = useCallback(() => {
    if (isStreaming) {
      abortRef.current?.abort();
      return;
    }
    const trimmed = input.trim();
    if (!trimmed || !model) return;
    void runTranslation(trimmed);
  }, [input, isStreaming, model, runTranslation]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setInput("");
    setOutput("");
    setError(null);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      toast.show({ kind: "success", message: t("Copied") });
    } catch {
      toast.show({ kind: "error", message: t("Translation failed") });
    }
  }, [output, toast, t]);

  const modelOptions: ModelOption[] = useMemo(
    () => modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })),
    [modelList],
  );

  const modelsByProvider = useMemo(() => {
    const groups: { provider: string; options: ModelOption[] }[] = [];
    for (const opt of modelOptions) {
      const g = groups.find((x) => x.provider === opt.provider);
      if (g) g.options.push(opt);
      else groups.push({ provider: opt.provider, options: [opt] });
    }
    return groups;
  }, [modelOptions]);

  const currentName = useMemo(() => {
    if (!model) return null;
    return modelOptions.find((o) => o.provider === model.provider && o.modelId === model.modelId)?.name ?? model.modelId;
  }, [model, modelOptions]);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "var(--bg)",
    }}>
      {/* Top bar: model selector + target selector + copy + clear */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6, padding: "8px 10px",
        borderBottom: "1px solid var(--border)", flexShrink: 0, position: "relative",
      }}>
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
              setModelDropdownOpen((v) => !v);
            }}
            disabled={isStreaming || !currentName}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 10px", height: 28,
              maxWidth: 240, overflow: "hidden",
              background: modelDropdownOpen ? "var(--bg-hover)" : "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              cursor: isStreaming ? "not-allowed" : "pointer",
              fontSize: 12,
              opacity: isStreaming ? 0.5 : 1,
            }}
          >
            <ProviderIcon id={model?.provider ?? ""} size={12} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentName ?? t("Model")}
            </span>
          </button>
          {modelDropdownOpen && modelDropdownRect && (
            <div ref={panelRef} style={{
              position: "fixed",
              top: modelDropdownRect.top + 32,
              left: modelDropdownRect.left,
              zIndex: 500,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
              width: "max-content",
              minWidth: modelDropdownRect.width,
              maxHeight: Math.max(120, Math.min(window.innerHeight - modelDropdownRect.top - 40, 360)),
              overflowY: "auto",
            }}>
              {modelsByProvider.map((group, gi) => (
                <div key={group.provider}>
                  {modelsByProvider.length > 1 && (
                    <div style={{
                      padding: "6px 12px 4px",
                      fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                      textTransform: "uppercase", letterSpacing: "0.07em",
                      borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                    }}>
                      {group.provider}
                    </div>
                  )}
                  {group.options.map((opt) => {
                    const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                    return (
                      <button
                        key={`${opt.provider}:${opt.modelId}`}
                        onClick={() => {
                          setModelDropdownOpen(false);
                          if (!isActive) {
                            setModel({ provider: opt.provider, modelId: opt.modelId });
                          }
                        }}
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: isActive ? "var(--bg-selected)" : "none",
                          border: "none",
                          color: isActive ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: isActive ? 600 : 400, whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = isActive ? "var(--bg-selected)" : "none"; }}
                      >
                        {isActive
                          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                          : <span style={{ width: 10, flexShrink: 0 }} />}
                        {opt.name}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <Tooltip content={t("Target language")}>
          <div ref={targetDropdownRef} style={{ position: "relative" }}>
            <button
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setTargetDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                setTargetDropdownOpen((v) => !v);
              }}
              disabled={isStreaming}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "0 10px", height: 28,
                maxWidth: 140,
                background: targetDropdownOpen ? "var(--bg-hover)" : "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                cursor: isStreaming ? "not-allowed" : "pointer",
                fontSize: 12,
                opacity: isStreaming ? 0.5 : 1,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>
                {t(SUPPORTED_LANGUAGES.find((l) => l.code === target)?.i18nKey ?? "")}
              </span>
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                style={{ flexShrink: 0, color: "var(--text-dim)" }}
              >
                <polyline points="2 4 5 7 8 4" />
              </svg>
            </button>
            {targetDropdownOpen && targetDropdownRect && (
              <div ref={targetPanelRef} style={{
                position: "fixed",
                top: targetDropdownRect.top + 32,
                left: targetDropdownRect.left,
                zIndex: 500,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                width: "max-content",
                minWidth: targetDropdownRect.width,
                maxHeight: Math.max(120, Math.min(window.innerHeight - targetDropdownRect.top - 40, 360)),
                overflowY: "auto",
              }}>
                {SUPPORTED_LANGUAGES.map((opt) => {
                  const isActive = opt.code === target;
                  return (
                    <button
                      key={opt.code}
                      onClick={() => {
                        setTargetDropdownOpen(false);
                        if (!isActive) {
                          setTarget(opt.code);
                          setPreviewOpen(false);
                        }
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "7px 12px",
                        background: isActive ? "var(--bg-selected)" : "none",
                        border: "none",
                        color: isActive ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer", fontSize: 12, textAlign: "left",
                        fontWeight: isActive ? 600 : 400, whiteSpace: "nowrap",
                      }}
                      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = isActive ? "var(--bg-selected)" : "none"; }}
                    >
                      {isActive
                        ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                        : <span style={{ width: 10, flexShrink: 0 }} />}
                      {t(opt.i18nKey)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Tooltip>
        <Tooltip content={isStreaming ? t("Stop") : (input.trim() ? t("Translate (⌘+Enter)") : t("Type text to translate…"))}>
          <button
            onClick={handleTranslate}
            disabled={!isStreaming && (!input.trim() || !model)}
            aria-label={isStreaming ? t("Stop") : t("Translate")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              gap: 4, padding: "0 10px", height: 28,
              background: isStreaming ? "var(--bg)" : "var(--accent)",
              color: isStreaming ? "var(--text)" : "var(--accent-fg, #fff)",
              border: "1px solid var(--border)", borderRadius: 6,
              cursor: (!isStreaming && (!input.trim() || !model)) ? "not-allowed" : "pointer",
              fontSize: 12, fontWeight: 600,
              opacity: (!isStreaming && (!input.trim() || !model)) ? 0.5 : 1,
            }}
          >
            {isStreaming ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5h12" />
                <path d="M9 3v2" />
                <path d="M5 5c0 4 3 7 6 9" />
                <path d="M11 5c0 3-2 6-6 8" />
                <path d="M14 21l5-12 5 12" />
                <path d="M15.5 17h7" />
              </svg>
            )}
            {isStreaming ? t("Stop") : t("Translate")}
          </button>
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Tooltip content={t("Prompt preview")}>
          <button
            onClick={() => setPreviewOpen((v) => !v)}
            onMouseEnter={() => setHoveredAction("prompts")}
            onMouseLeave={() => setHoveredAction(null)}
            aria-pressed={previewOpen}
            aria-label={t("Prompts")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              gap: hoveredAction === "prompts" ? 4 : 0,
              padding: "0 10px", height: 28,
              background: previewOpen ? "var(--bg-hover)" : "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 6,
              cursor: "pointer", fontSize: 12,
              transition: "gap 0.15s",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="13" y2="17" />
            </svg>
            <span style={{
              opacity: hoveredAction === "prompts" ? 1 : 0,
              maxWidth: hoveredAction === "prompts" ? 80 : 0,
              overflow: "hidden", whiteSpace: "nowrap",
              transition: "opacity 0.15s, max-width 0.15s",
            }}>
              {t("Prompts")}
            </span>
          </button>
        </Tooltip>
        <Tooltip content={output ? "" : t("Clear")}>
          <button
            onClick={handleCopy}
            onMouseEnter={() => setHoveredAction("copy")}
            onMouseLeave={() => setHoveredAction(null)}
            disabled={!output}
            aria-label={t("Copy")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              gap: hoveredAction === "copy" ? 4 : 0,
              padding: "0 10px", height: 28,
              background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 6,
              cursor: !output ? "not-allowed" : "pointer", fontSize: 12,
              opacity: !output ? 0.5 : 1,
              transition: "gap 0.15s",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span style={{
              opacity: hoveredAction === "copy" ? 1 : 0,
              maxWidth: hoveredAction === "copy" ? 80 : 0,
              overflow: "hidden", whiteSpace: "nowrap",
              transition: "opacity 0.15s, max-width 0.15s",
            }}>
              {t("Copy")}
            </span>
          </button>
        </Tooltip>
        <button
          onClick={handleClear}
          onMouseEnter={() => setHoveredAction("clear")}
          onMouseLeave={() => setHoveredAction(null)}
          disabled={!input && !output}
          aria-label={t("Clear")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: hoveredAction === "clear" ? 4 : 0,
            padding: "0 10px", height: 28,
            background: "var(--bg)", color: "var(--text)",
            border: "1px solid var(--border)", borderRadius: 6,
            cursor: (!input && !output) ? "not-allowed" : "pointer", fontSize: 12,
            opacity: (!input && !output) ? 0.5 : 1,
            transition: "gap 0.15s",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          </svg>
          <span style={{
            opacity: hoveredAction === "clear" ? 1 : 0,
            maxWidth: hoveredAction === "clear" ? 80 : 0,
            overflow: "hidden", whiteSpace: "nowrap",
            transition: "opacity 0.15s, max-width 0.15s",
          }}>
            {t("Clear")}
          </span>
        </button>
      </div>

      {/* Prompt preview pane — read-only view of the active target's prompt.
          Updates live when target changes (no state sync needed). */}
      {previewOpen && (
        <div style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          flexShrink: 0,
          display: "flex", flexDirection: "column", gap: 6,
          maxHeight: 220,
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            fontSize: 11, color: "var(--text)",
          }}>
            <span>
              {t("Prompt preview")}
              {" · "}
              {t(SUPPORTED_LANGUAGES.find((l) => l.code === target)?.i18nKey ?? "")}
            </span>
            <Tooltip content={t("Close")}>
              <button
                onClick={() => setPreviewOpen(false)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, padding: 0,
                  background: "transparent",
                  color: "var(--text-dim)",
                  border: "none", borderRadius: 4,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="2" y1="2" x2="8" y2="8" />
                  <line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            </Tooltip>
          </div>
          <pre style={{
            margin: 0,
            padding: "8px 10px",
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
            overflowY: "auto",
            flex: 1, minHeight: 0,
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {TRANSLATE_PROMPTS[target]}
          </pre>
        </div>
      )}

      {/* Input area — flex: 1 so it shares the panel height 1:1 with the output area. */}
      <div style={{ padding: "10px 12px 6px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
          {t("Translation input")}
        </div>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter triggers translation (or stops, if streaming).
            // Plain Enter still inserts a newline — translation is an
            // explicit action, not an auto-fire.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleTranslate();
            }
          }}
          placeholder={t("Type text to translate…")}
          style={{
            width: "100%", flex: 1, minHeight: 0, resize: "none",
            padding: "8px 10px",
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            outline: "none",
            boxSizing: "border-box",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
        />
      </div>

      {/* Output area */}
      <div style={{ padding: "0 12px 12px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontSize: 11, color: "var(--text-dim)", marginBottom: 4, minHeight: 16,
        }}>
          <span>{t("Translation output")}</span>
          {isStreaming && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--accent)" }}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" style={{ animation: "pulse 1.2s infinite" }}>
                <circle cx="5" cy="5" r="3" />
              </svg>
              <span>{t("Translating…")}</span>
              <Tooltip content={t("Stop")}>
                <button
                  onClick={handleStop}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 18, height: 18, padding: 0,
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.borderColor = "var(--text-muted)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; }}
                >
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1" /></svg>
                </button>
              </Tooltip>
            </span>
          )}
        </div>
        <div
          ref={outputRef}
          style={{
            flex: 1, minHeight: 0, overflowY: "auto",
            padding: "10px 12px",
            background: "var(--bg)",
            color: error ? "#ef4444" : "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 13, lineHeight: 1.6,
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            fontFamily: "var(--font-mono)",
          }}
        >
          {error ? error : output || (
            <span style={{ color: "var(--text-dim)" }}>{t("Translated text will appear here")}</span>
          )}
        </div>
      </div>
    </div>
  );
}