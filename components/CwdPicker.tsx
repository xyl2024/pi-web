"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspacesResponse } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";
import { useToast } from "./Toast";

/**
 * Reusable cwd picker — the previously inline picker that lived in the
 * sidebar header, now reused in ChatInput for the new-session flow.
 *
 * UI matches the model picker in ChatInput's bottom toolbar (folder icon +
 * basename pill), while the dropdown mirrors the original sidebar menu:
 * Pinned / Recent list, plus Use default / Create space / Custom path
 * entries at the bottom. Dropdown opens upward by default since the parent
 * is anchored at the bottom of the chat area — pass `dropdownDirection`
 * to flip it if needed.
 */
interface CwdPickerProps {
  /** Current cwd; null means "no project selected yet". */
  cwd: string | null;
  /** Fires when the user picks a different cwd (or creates one). */
  onCwdChange: (cwd: string) => void;
  /** Grays the trigger and ignores click. */
  disabled?: boolean;
  /** Max width of the trigger pill in pixels. */
  maxWidth?: number;
  /** Open upward (default) or downward. */
  dropdownDirection?: "up" | "down";
}

const WORKSPACE_LIMIT = 5;

function basenameOf(cwd: string): string {
  // Pick the separator that actually appears in the path. Windows uses
  // backslashes; POSIX uses slashes. If both are present (unusual but
  // legal on Windows after POSIX tools), prefer "/" so mixed paths render
  // sensibly. filter(Boolean) drops the empty leading segment produced by
  // absolute paths.
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const parts = cwd.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function shortenPath(cwd: string, homeDir: string): string {
  const path = homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 5) return path;
  return "…/" + parts.slice(-5).join(sep);
}

export function CwdPicker({
  cwd,
  onCwdChange,
  disabled = false,
  maxWidth = 220,
  dropdownDirection = "up",
}: CwdPickerProps) {
  const { t } = useI18n();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<{ cwd: string }[] | null>(null);
  const [pinnedCwds, setPinnedCwds] = useState<string[]>([]);
  const [homeDir, setHomeDir] = useState<string>("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [createSpaceValue, setCreateSpaceValue] = useState("");
  const [createSpaceError, setCreateSpaceError] = useState<string | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const createSpaceInputRef = useRef<HTMLInputElement>(null);
  // Single click target — both the trigger and dropdown live under it, so
  // outside-click detection just walks up the DOM for this data attribute.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Refresh dropdown contents whenever it opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      fetch(`/api/workspaces?limit=${WORKSPACE_LIMIT}`).then((r) => r.json() as Promise<WorkspacesResponse>),
      fetch("/api/pinned-cwds").then((r) => r.json() as Promise<{ cwds?: string[] }>),
      fetch("/api/home").then((r) => r.json() as Promise<{ home?: string }>),
    ]).then(([ws, pin, hd]) => {
      if (cancelled) return;
      setWorkspaces(ws.workspaces.map((w) => ({ cwd: w.cwd })));
      if (Array.isArray(pin.cwds)) setPinnedCwds(pin.cwds);
      if (hd.home) setHomeDir(hd.home);
    }).catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [open]);

  // Close on outside mousedown.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) {
        setOpen(false);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCreateSpaceOpen(false);
        setCreateSpaceValue("");
        setCreateSpaceError(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handlePick = useCallback((picked: string) => {
    onCwdChange(picked);
    setOpen(false);
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCreateSpaceOpen(false);
    setCreateSpaceValue("");
    setCreateSpaceError(null);
  }, [onCwdChange]);

  const togglePin = useCallback(async (targetCwd: string) => {
    const prev = pinnedCwds;
    const next = prev.includes(targetCwd)
      ? prev.filter((p) => p !== targetCwd)
      : [...prev, targetCwd];
    setPinnedCwds(next);
    try {
      await fetch("/api/pinned-cwds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwds: next }),
      });
    } catch {
      setPinnedCwds(prev);
      toast.show({ kind: "error", message: t("Failed to update pin") });
    }
  }, [pinnedCwds, t, toast]);

  const handleCommitCustomPath = useCallback(() => {
    const path = customPathValue.trim();
    if (path) handlePick(path);
  }, [customPathValue, handlePick]);

  const handleCommitCreateSpace = useCallback(async () => {
    const dirName = createSpaceValue.trim();
    if (!dirName || creatingSpace) return;
    setCreatingSpace(true);
    setCreateSpaceError(null);
    try {
      const res = await fetch("/api/create-space", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir_name: dirName }),
      });
      const data = await res.json() as { cwd?: string; error?: string };
      if (!res.ok || !data.cwd) {
        const msg = data.error ?? `HTTP ${res.status}`;
        setCreateSpaceError(msg);
        toast.show({ kind: "error", message: msg });
        return;
      }
      handlePick(data.cwd);
      toast.show({ kind: "success", message: t("Space created") });
    } catch (e) {
      const msg = String(e);
      setCreateSpaceError(msg);
      toast.show({ kind: "error", message: msg });
    } finally {
      setCreatingSpace(false);
    }
  }, [createSpaceValue, creatingSpace, handlePick, t, toast]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string };
      if (data.cwd) handlePick(data.cwd);
    } catch { /* ignore */ }
  }, [handlePick]);

  const pinnedCwdSet = new Set(pinnedCwds);
  const unpinnedCwds = (workspaces ?? [])
    .filter((w) => !pinnedCwdSet.has(w.cwd))
    .map((w) => w.cwd);

  const up = dropdownDirection === "up";
  const buttonLabel = cwd ? basenameOf(cwd) : t("Select project...");
  const buttonTitle = cwd ? t("Change project") : t("Pick a project");

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <Tooltip content={buttonTitle}>
        <button
          onClick={() => { if (!disabled) setOpen((v) => !v); }}
          disabled={disabled}
          aria-label={buttonTitle}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "8px 12px",
            height: 32,
            maxWidth, overflow: "hidden",
            background: open ? "var(--bg-hover)" : "none",
            border: "none",
            borderRadius: 9,
            color: cwd ? "var(--text)" : "var(--text-muted)",
            cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 12,
            opacity: disabled ? 0.5 : 1,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => {
            if (disabled) return;
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            if (disabled) return;
            e.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
            e.currentTarget.style.color = cwd ? "var(--text)" : "var(--text-muted)";
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, fontFamily: "var(--font-mono)" }}>
            {buttonLabel}
          </span>
        </button>
      </Tooltip>

      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
            left: 0,
            zIndex: 100,
            minWidth: 280,
            maxWidth: 360,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.32)",
            overflow: "hidden",
            fontSize: 12,
          }}
        >
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {/* Pinned section */}
            {pinnedCwds.length > 0 && (
              <>
                <div style={{ padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {t("Pinned")}
                </div>
                {pinnedCwds.map((pcwd) => (
                  <Tooltip key={`pinned-${pcwd}`} content={pcwd}>
                    <button
                      onClick={() => handlePick(pcwd)}
                      style={{
                        display: "flex", alignItems: "center", gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: pcwd === cwd ? "var(--bg-selected)" : "none",
                        border: "none", borderBottom: "1px solid var(--border)",
                        color: pcwd === cwd ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      <Tooltip content="Unpin">
                        <span
                          onClick={(e) => { e.stopPropagation(); togglePin(pcwd); }}
                          style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: "pointer", padding: 2 }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
                            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z" />
                          </svg>
                        </span>
                      </Tooltip>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {shortenPath(pcwd, homeDir)}
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </>
            )}

            {/* Recent section */}
            {unpinnedCwds.length > 0 && (
              <>
                <div style={{ padding: pinnedCwds.length > 0 ? "4px 10px 3px" : "6px 10px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {t("Recent")}
                </div>
                {unpinnedCwds.map((rcwd) => (
                  <Tooltip key={`recent-${rcwd}`} content={rcwd}>
                    <button
                      onClick={() => handlePick(rcwd)}
                      style={{
                        display: "flex", alignItems: "center", gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: rcwd === cwd ? "var(--bg-selected)" : "none",
                        border: "none", borderBottom: "1px solid var(--border)",
                        color: rcwd === cwd ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      <Tooltip content="Pin">
                        <span
                          onClick={(e) => { e.stopPropagation(); togglePin(rcwd); }}
                          style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: "pointer", padding: 2, opacity: 0.45 }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z" />
                          </svg>
                        </span>
                      </Tooltip>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {shortenPath(rcwd, homeDir)}
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </>
            )}

            {/* Empty state inside the dropdown */}
            {pinnedCwds.length === 0 && unpinnedCwds.length === 0 && (
              <div style={{ padding: "10px", fontSize: 11, color: "var(--text-dim)" }}>
                {t("No projects yet")}
              </div>
            )}
          </div>

          {/* Footer entries */}
          {!customPathOpen && !createSpaceOpen && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); void handleDefaultCwd(); }}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  width: "100%", padding: "8px 10px",
                  background: "none", border: "none",
                  borderTop: (pinnedCwds.length > 0 || unpinnedCwds.length > 0) ? "1px solid var(--border)" : "none",
                  color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                </svg>
                <span>{t("Use default directory")}</span>
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCreateSpaceOpen(true);
                  setCreateSpaceError(null);
                  setTimeout(() => createSpaceInputRef.current?.focus(), 0);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  width: "100%", padding: "8px 10px",
                  background: "none", border: "none",
                  color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  <line x1="5" y1="4.3" x2="5" y2="7.3" />
                  <line x1="3.5" y1="5.8" x2="6.5" y2="5.8" />
                </svg>
                <span>{t("Create space...")}</span>
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCustomPathOpen(true);
                  setCreateSpaceOpen(false);
                  setCreateSpaceValue("");
                  setCreateSpaceError(null);
                  setTimeout(() => customPathInputRef.current?.focus(), 0);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  width: "100%", padding: "8px 10px",
                  background: "none", border: "none",
                  color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("Custom path...")}</span>
              </button>
            </>
          )}

          {createSpaceOpen && (
            <div style={{ padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
              <input
                ref={createSpaceInputRef}
                value={createSpaceValue}
                onChange={(e) => {
                  setCreateSpaceValue(e.target.value);
                  setCreateSpaceError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCommitCreateSpace();
                  if (e.key === "Escape") {
                    setCreateSpaceOpen(false);
                    setCreateSpaceValue("");
                    setCreateSpaceError(null);
                  }
                }}
                placeholder={t("dir name")}
                disabled={creatingSpace}
                style={{
                  width: "100%", fontSize: 11, fontFamily: "var(--font-mono)",
                  padding: "5px 8px",
                  border: "1px solid var(--accent)", borderRadius: 5,
                  outline: "none", background: "var(--bg)", color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              {createSpaceError && (
                <div style={{ marginTop: 5, color: "#f87171", fontSize: 11, lineHeight: 1.35 }}>
                  {createSpaceError}
                </div>
              )}
              <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                <button
                  onClick={() => { void handleCommitCreateSpace(); }}
                  disabled={creatingSpace || !createSpaceValue.trim()}
                  style={{
                    flex: 1, padding: "4px 0",
                    background: "var(--accent)", border: "none", borderRadius: 5,
                    color: "#fff", fontSize: 11, fontWeight: 600,
                    cursor: creatingSpace || !createSpaceValue.trim() ? "default" : "pointer",
                    opacity: creatingSpace || !createSpaceValue.trim() ? 0.6 : 1,
                  }}
                >
                  {creatingSpace ? t("Creating...") : t("Create")}
                </button>
                <button
                  onClick={() => {
                    setCreateSpaceOpen(false);
                    setCreateSpaceValue("");
                    setCreateSpaceError(null);
                  }}
                  disabled={creatingSpace}
                  style={{
                    flex: 1, padding: "4px 0",
                    background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5,
                    color: "var(--text-muted)", fontSize: 11,
                    cursor: creatingSpace ? "default" : "pointer",
                    opacity: creatingSpace ? 0.6 : 1,
                  }}
                >
                  {t("Cancel")}
                </button>
              </div>
            </div>
          )}

          {customPathOpen && (
            <div style={{ padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
              <input
                ref={customPathInputRef}
                value={customPathValue}
                onChange={(e) => setCustomPathValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCommitCustomPath();
                  if (e.key === "Escape") {
                    setCustomPathOpen(false);
                    setCustomPathValue("");
                  }
                }}
                placeholder="/path/to/project"
                style={{
                  width: "100%", fontSize: 11, fontFamily: "var(--font-mono)",
                  padding: "5px 8px",
                  border: "1px solid var(--accent)", borderRadius: 5,
                  outline: "none", background: "var(--bg)", color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                <button
                  onClick={handleCommitCustomPath}
                  style={{
                    flex: 1, padding: "4px 0",
                    background: "var(--accent)", border: "none", borderRadius: 5,
                    color: "#fff", fontSize: 11, fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {t("Open")}
                </button>
                <button
                  onClick={() => { setCustomPathOpen(false); setCustomPathValue(""); }}
                  style={{
                    flex: 1, padding: "4px 0",
                    background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5,
                    color: "var(--text-muted)", fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {t("Cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
