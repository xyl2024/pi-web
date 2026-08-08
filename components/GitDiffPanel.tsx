"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import type { GitDiffFile, GitStatusResponse } from "@/lib/git-diff-types";

interface Props {
  cwd: string | null;
}

const STATUS_LABEL: Record<GitDiffFile["status"], string> = {
  "A": "A", "M": "M", "D": "D", "R": "R", "C": "C", "T": "T", "U": "U", "??": "?",
};

const STATUS_COLOR: Record<GitDiffFile["status"], string> = {
  "A": "var(--git-status-added)",
  "M": "var(--git-status-modified)",
  "D": "var(--git-status-deleted)",
  "R": "var(--git-status-renamed)",
  "C": "var(--git-status-renamed)",
  "T": "var(--git-status-renamed)",
  "U": "var(--git-status-conflict)",
  "??": "var(--text-dim)",
};

/** One line of a unified diff, classified for coloring. */
type DiffLineType = "file" | "hunk" | "add" | "del" | "meta" | "context";

function classifyLine(line: string): DiffLineType {
  if (line.startsWith("diff --git ") || line.startsWith("index ") ||
      line.startsWith("new file ") || line.startsWith("deleted file ") ||
      line.startsWith("Binary files ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "file";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("\\")) return "meta";
  return "context";
}

export function GitDiffPanel({ cwd }: Props) {
  const { t } = useI18n();
  const toast = useToast();

  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error === "cwd_not_allowed" ? t("Not allowed") : `HTTP ${res.status}`);
      }
      const data = (await res.json()) as GitStatusResponse;
      setStatus(data);
      // Re-select the previously selected file if it still exists.
      setSelectedPath((prev) => (prev && data.files.some((f) => f.path === prev) ? prev : null));
      setDiffText(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.show({ kind: "error", message: msg || t("Refresh") });
    } finally {
      setLoading(false);
    }
  }, [cwd, toast, t]);

  // Load the overview when the cwd changes (or on mount).
  useEffect(() => {
    setStatus(null);
    setSelectedPath(null);
    setDiffText(null);
    if (cwd) void loadStatus();
  }, [cwd, loadStatus]);

  const loadDiff = useCallback(async (path: string, stagedSide: boolean) => {
    if (!cwd) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const res = await fetch(
        `/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(path)}&staged=${stagedSide ? "1" : "0"}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { diff: string | null; truncated: boolean };
      setDiffText(data.diff);
      setDiffTruncated(data.truncated);
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
      setDiffText(null);
    } finally {
      setDiffLoading(false);
    }
  }, [cwd]);

  // Load the diff when the selection or staged side changes.
  useEffect(() => {
    if (!selectedPath) {
      setDiffText(null);
      setDiffError(null);
      return;
    }
    void loadDiff(selectedPath, staged);
  }, [selectedPath, staged, loadDiff]);

  const handleSelectFile = useCallback((f: GitDiffFile) => {
    // Default to the side that actually has changes for this file.
    if (f.status === "??") setStaged(false);
    else if (f.hasUnstaged && !f.hasStaged && staged) setStaged(false);
    else if (f.hasStaged && !f.hasUnstaged && !staged) setStaged(true);
    setSelectedPath(f.path);
  }, [staged]);

  // Files visible under the current staged/unstaged filter.
  // Untracked files (`??`) show only in the Unstaged view.
  const visibleFiles = useMemo(() => {
    if (!status) return [];
    return status.files.filter((f) =>
      staged ? f.hasStaged : (f.hasUnstaged || f.status === "??")
    );
  }, [status, staged]);

  // When the staged toggle changes, clear the selection if the current file
  // is no longer in the visible list.
  useEffect(() => {
    if (selectedPath && !visibleFiles.some((f) => f.path === selectedPath)) {
      setSelectedPath(null);
    }
  }, [visibleFiles, selectedPath]);

  const repoName = status?.repoRoot ? status.repoRoot.split("/").pop() || status.repoRoot : null;
  const selectedFile = visibleFiles.find((f) => f.path === selectedPath) ?? null;

  const diffLines = useCallback((diff: string) => diff.split("\n"), []);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "var(--bg)",
    }}>
      {/* Header: repo info + refresh */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "8px 10px", borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="6" r="3" />
          <path d="M6 9v6" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        {status?.repoRoot ? (
          <span style={{
            fontSize: 12, color: "var(--text)", fontWeight: 600,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {status.branch ? (
              <span style={{ color: "var(--accent)" }}>{status.branch}</span>
            ) : null}
            {status.branch ? " · " : ""}
            {repoName}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("Git Diff")}</span>
        )}
        <div style={{ flex: 1 }} />
        <Tooltip content={t("Refresh")}>
          <button
            onClick={() => void loadStatus()}
            disabled={!cwd || loading}
            aria-label={t("Refresh")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "var(--bg)", color: "var(--text-muted)",
              border: "1px solid var(--border)", borderRadius: 6,
              cursor: (!cwd || loading) ? "not-allowed" : "pointer",
              opacity: (!cwd || loading) ? 0.5 : 1,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: loading ? "spin 0.9s linear infinite" : undefined }}>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
        </Tooltip>
      </div>

      {loading && !status ? (
        <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
          {t("Loading…")}
        </div>
      ) : error ? (
        <div style={{ padding: "24px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 12, color: "#f87171", textAlign: "center" }}>{error}</div>
          <button
            onClick={() => void loadStatus()}
            style={{
              padding: "4px 12px", fontSize: 12,
              background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
            }}
          >
            {t("Retry")}
          </button>
        </div>
      ) : !status ? (
        <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
          {cwd ? t("Loading…") : t("Open a session first")}
        </div>
      ) : !status.repoRoot ? (
        <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
          {t("Not a git repository")}
        </div>
      ) : status.files.length === 0 ? (
        <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
          {t("No changes")}
        </div>
      ) : (
        <>
          {/* Staged/Unstaged toggle */}
          <div style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "6px 10px", borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)", marginRight: 4 }}>
              {t("View")}
            </span>
            {([false, true] as const).map((side) => (
              <button
                key={side ? "staged" : "unstaged"}
                onClick={() => setStaged(side)}
                disabled={diffLoading}
                style={{
                  padding: "3px 10px", fontSize: 11, borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: staged === side ? "var(--bg-selected)" : "var(--bg)",
                  color: staged === side ? "var(--text)" : "var(--text-muted)",
                  cursor: diffLoading ? "not-allowed" : "pointer",
                  fontWeight: staged === side ? 600 : 400,
                }}
              >
                {side ? t("Staged") : t("Unstaged")}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {status.files.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {t("{n} files changed").replace("{n}", String(visibleFiles.length))}
              </span>
            )}
          </div>

          {/* File list */}
          <div style={{
            flex: "0 0 40%", minHeight: 80, overflowY: "auto",
            borderBottom: "1px solid var(--border)",
          }}>
            {visibleFiles.length === 0 ? (
              <div style={{ padding: "20px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
                {staged ? t("No staged changes") : t("No unstaged changes")}
              </div>
            ) : (
            visibleFiles.map((f) => {
              const active = f.path === selectedPath;
              return (
                <button
                  key={f.path}
                  onClick={() => handleSelectFile(f)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    width: "100%", padding: "5px 10px",
                    background: active ? "var(--bg-selected)" : "transparent",
                    border: "none", borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                    color: "var(--text)", cursor: "pointer", textAlign: "left",
                    fontSize: 12,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = active ? "var(--bg-selected)" : "transparent"; }}
                >
                  <span style={{
                    width: 16, flexShrink: 0, textAlign: "center",
                    fontSize: 10, fontWeight: 700,
                    color: STATUS_COLOR[f.status],
                    border: `1px solid ${STATUS_COLOR[f.status]}`,
                    borderRadius: 3, padding: "0 1px",
                  }}>
                    {STATUS_LABEL[f.status]}
                  </span>
                  <span style={{
                    flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    color: f.status === "??" ? "var(--text-muted)" : "var(--text)",
                  }}>
                    {f.path}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)" }}>
                    {f.additions > 0 && <span style={{ color: "#16a34a" }}>+{f.additions}</span>}
                    {f.additions > 0 && f.deletions > 0 && " "}
                    {f.deletions > 0 && <span style={{ color: "#ef4444" }}>-{f.deletions}</span>}
                  </span>
                </button>
              );
            })
          )}
          </div>

          {/* Diff view */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg)" }}>
            {diffError ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: "#f87171" }}>{diffError}</div>
            ) : diffLoading ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)" }}>
                {t("Loading…")}
              </div>
            ) : !selectedFile ? (
              <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
                {t("Select a file to view its diff")}
              </div>
            ) : diffText === null ? (
              <div style={{ padding: "24px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
                {t("No changes for this file")}
              </div>
            ) : (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.55, padding: "4px 0" }}>
                {diffTruncated && (
                  <div style={{
                    margin: "4px 10px", padding: "6px 10px", fontSize: 11,
                    background: "rgba(234,179,8,0.12)", color: "#d97706",
                    border: "1px solid rgba(234,179,8,0.3)", borderRadius: 6,
                  }}>
                    {t("Diff truncated")}
                  </div>
                )}
                {/* Wrapper is `inline-block` so it grows with the widest line;
                    `minWidth: 100%` keeps short content filling the viewport.
                    Child divs are plain `block` and stretch to this wrapper. */}
                <div style={{ display: "inline-block", minWidth: "100%" }}>
                {diffLines(diffText).map((line, i) => {
                  const type = classifyLine(line);
                  const style: React.CSSProperties = {
                    padding: "0 10px",
                    whiteSpace: "pre",
                  };
                  if (type === "add") {
                    style.background = "rgba(34,197,94,0.13)";
                    style.color = "#16a34a";
                  } else if (type === "del") {
                    style.background = "rgba(239,68,68,0.13)";
                    style.color = "#ef4444";
                  } else if (type === "hunk") {
                    style.background = "rgba(59,130,246,0.1)";
                    style.color = "#3b82f6";
                  } else if (type === "file") {
                    style.color = "var(--text-muted)";
                    style.fontWeight = 600;
                  } else if (type === "meta") {
                    style.color = "var(--text-dim)";
                  } else {
                    style.color = "var(--text)";
                  }
                  return <div key={i} style={style}>{line || " "}</div>;
                })}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
