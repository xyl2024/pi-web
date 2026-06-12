"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTheme } from "@/hooks/useTheme";
import { useToast } from "./Toast";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";
import { extractImageGallery, MarkdownImage, ImageLightbox } from "./ImageLightbox";
import { encodeFilePathForApi, getFileName, getRelativeFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";
import { Document, Page, pdfjs } from "react-pdf";

import "@excalidraw/excalidraw/index.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false },
);

interface Props {
  filePath: string;
  cwd?: string;
}

interface FileData {
  content: string;
  language: string;
  size: number;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm"]);
const PDF_EXTS = new Set(["pdf"]);
const EXCALIDRAW_EXT = "excalidraw";

function isImagePath(filePath: string): boolean {
  const base = getFileName(filePath);
  const ext = base.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTS.has(ext);
}

function isAudioPath(filePath: string): boolean {
  const base = getFileName(filePath);
  const ext = base.toLowerCase().split(".").pop() ?? "";
  return AUDIO_EXTS.has(ext);
}

function isExcalidrawPath(filePath: string): boolean {
  const base = getFileName(filePath);
  const ext = base.toLowerCase().split(".").pop() ?? "";
  return ext === EXCALIDRAW_EXT;
}

function isPdfPath(filePath: string): boolean {
  const base = getFileName(filePath);
  const ext = base.toLowerCase().split(".").pop() ?? "";
  return PDF_EXTS.has(ext);
}

type DiffLine =
  | { type: "unchanged"; text: string; lineNo: number }
  | { type: "removed"; text: string; lineNo: number }
  | { type: "added"; text: string; lineNo: number };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Myers diff — returns line-level unified diff
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max];
      } else {
        x = v[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= m && y >= n) {
        // backtrack
        const result: DiffLine[] = [];
        let cx = m, cy = n;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd - 1];
          const pk = cx - cy;
          let prevK: number;
          if (pk === -dd || (pk !== dd && pv[pk - 1 + max] < pv[pk + 1 + max])) {
            prevK = pk + 1;
          } else {
            prevK = pk - 1;
          }
          const prevX = pv[prevK + max];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
          }
          if (dd > 0) {
            if (cx > prevX) {
              cx--;
              result.unshift({ type: "removed", text: oldLines[cx], lineNo: cx + 1 });
            } else {
              cy--;
              result.unshift({ type: "added", text: newLines[cy], lineNo: cy + 1 });
            }
          }
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
        }
        return result;
      }
    }
  }
  // Fallback: treat all as replaced
  return [
    ...oldLines.map((t, i) => ({ type: "removed" as const, text: t, lineNo: i + 1 })),
    ...newLines.map((t, i) => ({ type: "added" as const, text: t, lineNo: i + 1 })),
  ];
}

function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string; language: string }) {
  const { t } = useI18n();
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = diffLines(oldLines, newLines);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("No changes")}
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  // Track running line number for added/unchanged lines
  const newLineNos: number[] = [];
  let nlo = 1;
  for (const line of diff) {
    if (line.type === "removed") {
      newLineNos.push(0);
    } else {
      newLineNos.push(nlo++);
    }
  }

  let diffIdx = 0;

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.6 }}>
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              ... {seg.count} {t("unchanged lines")} ...
            </div>
          );
          diffIdx += seg.count;
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          const idx = diffIdx + li;
          const newLno = newLineNos[idx];
          const bg =
            line.type === "added"
              ? "rgba(0,200,80,0.12)"
              : line.type === "removed"
              ? "rgba(240,60,60,0.14)"
              : "transparent";
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "#4ade80" : line.type === "removed" ? "#f87171" : "var(--text-dim)";

          return (
            <div
              key={li}
              style={{
                display: "flex",
                background: bg,
                borderLeft: line.type === "added"
                  ? "3px solid #4ade80"
                  : line.type === "removed"
                  ? "3px solid #f87171"
                  : "3px solid transparent",
              }}
            >
              <span
                style={{
                  minWidth: 44,
                  padding: "0 8px 0 16px",
                  textAlign: "right",
                  color: "var(--text-dim)",
                  userSelect: "none",
                  fontSize: 11,
                  lineHeight: 1.6,
                  borderRight: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  flexShrink: 0,
                }}
              >
                {line.type === "removed" ? line.lineNo : newLno || ""}
              </span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                  fontWeight: 600,
                }}
              >
                {prefix}
              </span>
              <span
                style={{
                  flex: 1,
                  padding: "0 8px 0 0",
                  whiteSpace: "pre",
                  color: "var(--text)",
                  overflowX: "auto",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
        });
        diffIdx += seg.lines.length;
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

function ImageViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath]);

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <Tooltip content={filePath}><span style={{ fontFamily: "var(--font-mono)" }}>
          {getRelativeFilePath(filePath, cwd)}
        </span></Tooltip>
        <span style={{ marginLeft: "auto" }}>{ext || "image"}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <Tooltip content={watching ? t("Live sync active") : t("Not watching")}>
        <span
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? t("live") : t("static")}
        </span>
        </Tooltip>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => {
              if (!error) toast.show({ kind: "error", message: t("Failed to load file") });
              setError(t("Failed to load image"));
            }}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

// Resolve a markdown image src against the markdown file's directory.
// Pure string ops — keeps the Node `path` module out of the client bundle.
function resolveRelativePath(src: string, mdFilePath: string): string {
  const normalized = normalizeFilePathSlashes(mdFilePath);
  // Already absolute (POSIX, Windows drive, or UNC) — use as-is
  if (src.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith("\\\\")) {
    return normalizeFilePathSlashes(src);
  }
  const isWindowsPath = /^[a-zA-Z]:/.test(normalized);
  const dir = normalized.replace(/[^/]+$/, ""); // strip filename
  const parts = (dir + src).split("/").filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  if (isWindowsPath && out[0]) {
    return out.length > 1 ? `${out[0]}/${out.slice(1).join("/")}` : out[0];
  }
  return "/" + out.join("/");
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath]);

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <Tooltip content={filePath}><span style={{ fontFamily: "var(--font-mono)" }}>
          {getRelativeFilePath(filePath, cwd)}
        </span></Tooltip>
        <span style={{ marginLeft: "auto" }}>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <Tooltip content={watching ? t("Live sync active") : t("Not watching")}>
        <span
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? t("live") : t("static")}
        </span>
        </Tooltip>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => {
              if (!error) toast.show({ kind: "error", message: t("Failed to load file") });
              setError(t("Failed to load audio"));
            }}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function ExcalidrawViewer({ filePath, cwd }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [initialData, setInitialData] = useState<object | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editKey, setEditKey] = useState(0);
  const sceneRef = useRef<{ elements: readonly unknown[]; appState: unknown; files: unknown } | null>(null);
  const rawFileRef = useRef<Record<string, unknown> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const restoreRef = useRef<((...args: any[]) => any) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInitialData(null);
    setIsEditing(false);
    setDirty(false);
    setEditKey(0);
    rawFileRef.current = null;
    sceneRef.current = null;

    const encoded = encodeFilePathForApi(filePath);

    Promise.all([
      fetch(`/api/files/${encoded}?type=read`).then((r) => r.json()),
      import("@excalidraw/excalidraw").then((m) => { restoreRef.current = m.restore; return m.restore; }),
    ])
      .then(([d, restore]) => {
        if (cancelled) return;
        if ((d as FileData & { error?: string }).error) {
          setError((d as FileData & { error?: string }).error!);
          toast.show({ kind: "error", message: t("Failed to load file") });
          return;
        }
        try {
          const raw = JSON.parse(d.content);
          rawFileRef.current = raw;
          const restored = restore(
            { elements: raw.elements, appState: raw.appState, files: raw.files },
            null,
            null,
          ) as Record<string, unknown> & { appState?: Record<string, unknown> };
          // In v0.18.x, restore may not convert collaborators to a Map, and
          // Next.js hot-reload can turn Maps into plain objects. Ensure it's
          // always a Map before handing it to the Excalidraw component.
          if (restored.appState) {
            const collab = (restored.appState as Record<string, unknown>).collaborators;
            if (!(collab instanceof Map)) {
              (restored.appState as Record<string, unknown>).collaborators = new Map(
                Array.isArray(collab) ? collab : Object.entries(collab ?? {}),
              );
            }
          }
          setInitialData(restored);
        } catch {
          setError(t("Invalid Excalidraw file"));
          toast.show({ kind: "error", message: t("Failed to load file") });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        toast.show({ kind: "error", message: t("Failed to load file") });
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [filePath, t, toast]);

  const handleEdit = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setDirty(false);
    setEditKey((k) => k + 1);
    sceneRef.current = null;
  }, []);

  const handleSave = useCallback(async () => {
    if (!sceneRef.current || !rawFileRef.current || !restoreRef.current) return;
    setSaving(true);
    try {
      const saveData = {
        ...rawFileRef.current,
        elements: sceneRef.current.elements,
        appState: sceneRef.current.appState,
        files: sceneRef.current.files,
      };
      const encoded = encodeFilePathForApi(filePath);
      const res = await fetch(`/api/files/${encoded}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: JSON.stringify(saveData, null, 2) }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      rawFileRef.current = saveData;
      // Re-restore so future cancel remounts start from the saved state
      const fresh = restoreRef.current(
        { elements: saveData.elements, appState: saveData.appState, files: saveData.files },
        null,
        null,
      ) as Record<string, unknown> & { appState?: Record<string, unknown> };
      if (fresh.appState) {
        const c = (fresh.appState as Record<string, unknown>).collaborators;
        if (!(c instanceof Map)) {
          (fresh.appState as Record<string, unknown>).collaborators = new Map(
            Array.isArray(c) ? c : Object.entries(c ?? {}),
          );
        }
      }
      setInitialData(fresh);
      setDirty(false);
      toast.show({ kind: "success", message: t("File saved") });
    } catch (e) {
      console.error("Excalidraw save failed", e);
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to save file") });
    } finally {
      setSaving(false);
    }
  }, [filePath, t, toast]);

  const handleChange = useCallback((elements: readonly unknown[], appState: unknown, files: unknown) => {
    sceneRef.current = { elements, appState, files };
    setDirty(true);
  }, []);

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("Loading...")}
      </div>
    );
  }

  if (error || !initialData) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
        {error || t("Failed to load Excalidraw file")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <Tooltip content={filePath}><span style={{ fontFamily: "var(--font-mono)" }}>
          {getRelativeFilePath(filePath, cwd)}
        </span></Tooltip>
        <span style={{ marginLeft: "auto" }}>excalidraw</span>
        {isEditing ? (
          <>
            {dirty && <span style={{ color: "#fbbf24", fontWeight: 600 }}>● unsaved</span>}
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              style={{
                padding: "2px 10px",
                fontSize: 11,
                fontWeight: 600,
                cursor: saving || !dirty ? "default" : "pointer",
                background: dirty ? "var(--accent)" : "var(--bg-hover)",
                color: dirty ? "#fff" : "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                opacity: saving || !dirty ? 0.5 : 1,
              }}
            >
              {saving ? t("Saving...") : t("Save")}
            </button>
            <button
              onClick={handleCancel}
              style={{
                padding: "2px 10px",
                fontSize: 11,
                cursor: "pointer",
                background: "var(--bg-hover)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 5,
              }}
            >
              {t("Cancel")}
            </button>
          </>
        ) : (
          <button
            onClick={handleEdit}
            style={{
              padding: "2px 10px",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              background: "var(--bg-hover)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 5,
            }}
          >
            {t("Edit")}
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Excalidraw
          key={editKey}
          initialData={initialData}
          viewModeEnabled={!isEditing}
          zenModeEnabled={!isEditing}
          onChange={isEditing ? handleChange : undefined}
        />
      </div>
    </div>
  );
}

function PdfViewer({ filePath, cwd }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [manualScale, setManualScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageNaturalWidth, setPageNaturalWidth] = useState(0);
  const [outline, setOutline] = useState<Array<{ title: string; pageNumber: number; depth: number }>>([]);
  const [showOutline, setShowOutline] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const outlineBtnRef = useRef<HTMLButtonElement>(null);
  const numPagesRef = useRef(0);

  // SSE watch — same pattern as ImageViewer/AudioViewer
  useEffect(() => {
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);
    setNumPages(0);
    setPageNumber(1);
    setFitWidth(true);
    setManualScale(1);
    setPageNaturalWidth(0);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath]);

  // Track container width for fit-to-width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Keyboard shortcuts: ← → for page navigation
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const editable = document.activeElement?.getAttribute("contenteditable");
      if (editable === "true" || editable === "") return;

      if (e.key === "ArrowLeft") {
        setPageNumber((prev) => Math.max(1, prev - 1));
      } else if (e.key === "ArrowRight") {
        setPageNumber((prev) => Math.min(numPagesRef.current || 1, prev + 1));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Click outside outline dropdown to close
  useEffect(() => {
    if (!showOutline) return;
    function onClick(e: MouseEvent) {
      if (outlineBtnRef.current && !outlineBtnRef.current.contains(e.target as Node)) {
        setShowOutline(false);
      }
    }
    // Delay so the toggle click doesn't immediately close
    const id = setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", onClick);
    };
  }, [showOutline]);

  function handleOutlineClick(pageNum: number) {
    setPageNumber(pageNum);
    setShowOutline(false);
  }

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function flattenOutline(items: any[], doc: any, depth: number): Promise<Array<{ title: string; pageNumber: number; depth: number }>> {
    const result: Array<{ title: string; pageNumber: number; depth: number }> = [];
    if (!items) return result;
    for (const item of items) {
      let pageNumber = 0;
      if (item.dest) {
        try {
          if (typeof item.dest === "string") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const resolved: any = await doc.getDestination(item.dest);
            if (Array.isArray(resolved) && resolved[0]) {
              const idx: number = await doc.getPageIndex(resolved[0]);
              pageNumber = idx + 1;
            }
          } else if (Array.isArray(item.dest) && item.dest[0]) {
            const idx: number = await doc.getPageIndex(item.dest[0]);
            pageNumber = idx + 1;
          }
        } catch { /* skip unresolvable dest */ }
      }
      if (pageNumber > 0) {
        result.push({ title: item.title, pageNumber, depth });
      }
      if (item.items) {
        const children = await flattenOutline(item.items, doc, depth + 1);
        result.push(...children);
      }
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onDocumentLoadSuccess(doc: any) {
    setNumPages(doc.numPages);
    numPagesRef.current = doc.numPages;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doc.getOutline().then((rawOutline: any[]) => {
      if (rawOutline && rawOutline.length > 0) {
        flattenOutline(rawOutline, doc, 0).then(setOutline);
      }
    }).catch(() => { /* PDF has no outline or failed to load */ });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onPageLoadSuccess(page: any) {
    if (page.originalWidth > 0) {
      setPageNaturalWidth(page.originalWidth);
    }
  }

  function changePage(delta: number) {
    setPageNumber((prev) => Math.max(1, Math.min(numPages || 1, prev + delta)));
  }

  function handlePageInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const val = parseInt(e.currentTarget.value, 10);
      if (Number.isFinite(val) && val >= 1 && val <= numPages) {
        setPageNumber(val);
      }
      e.currentTarget.value = "";
    }
  }

  function changeScale(delta: number) {
    setFitWidth(false);
    setManualScale((prev) =>
      Math.round(Math.max(0.5, Math.min(3, prev + delta)) * 100) / 100,
    );
  }

  function resetFitWidth() {
    setFitWidth(true);
    setManualScale(1);
  }

  // Compute display percentage and effective scale
  const displayPercent = fitWidth && pageNaturalWidth > 0 && containerWidth > 0
    ? Math.round(containerWidth * 0.9 / pageNaturalWidth * 100)
    : Math.round(manualScale * 100);
  const effectiveScale = fitWidth && containerWidth > 0 && pageNaturalWidth > 0
    ? containerWidth * 0.9 / pageNaturalWidth
    : manualScale;

  const formatSizeStr = size != null ? formatSize(size) : null;

  const btnBase: React.CSSProperties = {
    padding: "2px 8px",
    fontSize: 11,
    cursor: "pointer",
    background: "var(--bg-hover)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    fontFamily: "var(--font-mono)",
    lineHeight: "18px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <Tooltip content={filePath}>
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {getRelativeFilePath(filePath, cwd)}
          </span>
        </Tooltip>

        {formatSizeStr && <span style={{ marginLeft: 8 }}>{formatSizeStr}</span>}

        <span style={{ marginLeft: "auto" }} />

        {/* Page navigation */}
        <button
          onClick={() => changePage(-1)}
          disabled={pageNumber <= 1}
          style={{ ...btnBase, opacity: pageNumber <= 1 ? 0.4 : 1, cursor: pageNumber <= 1 ? "default" : "pointer" }}
        >
          ‹
        </button>
        <input
          ref={pageInputRef}
          type="text"
          defaultValue={String(pageNumber)}
          key={pageNumber}
          onKeyDown={handlePageInputKey}
          style={{
            width: 36,
            textAlign: "center",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text)",
            fontSize: 11,
            padding: "2px 2px",
            fontFamily: "var(--font-mono)",
          }}
        />
        <span style={{ color: "var(--text-dim)", minWidth: 28, textAlign: "center" }}>
          / {numPages || "…"}
        </span>
        <button
          onClick={() => changePage(1)}
          disabled={pageNumber >= numPages}
          style={{ ...btnBase, opacity: pageNumber >= numPages ? 0.4 : 1, cursor: pageNumber >= numPages ? "default" : "pointer" }}
        >
          ›
        </button>

        {/* Zoom controls */}
        <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
        <button
          onClick={() => changeScale(-0.25)}
          disabled={!fitWidth && manualScale <= 0.5}
          style={{ ...btnBase, opacity: !fitWidth && manualScale <= 0.5 ? 0.4 : 1, cursor: !fitWidth && manualScale <= 0.5 ? "default" : "pointer" }}
        >
          −
        </button>
        <button
          onClick={resetFitWidth}
          style={{
            ...btnBase,
            minWidth: 46,
            fontWeight: fitWidth ? 700 : 400,
            color: fitWidth ? "var(--accent)" : "var(--text-dim)",
          }}
          title={fitWidth ? t("Fit to width") : t("Reset to fit width")}
        >
          {displayPercent}%
        </button>
        <button
          onClick={() => changeScale(0.25)}
          disabled={!fitWidth && manualScale >= 3}
          style={{ ...btnBase, opacity: !fitWidth && manualScale >= 3 ? 0.4 : 1, cursor: !fitWidth && manualScale >= 3 ? "default" : "pointer" }}
        >
          +
        </button>

        {/* Outline button */}
        {outline.length > 0 && (
          <span style={{ position: "relative" }}>
            <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px", display: "inline-block" }} />
            <button
              ref={outlineBtnRef}
              onClick={() => setShowOutline((s) => !s)}
              style={{ ...btnBase }}
              title={t("Table of contents")}
            >
              ☰
            </button>
            {showOutline && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  minWidth: 220,
                  maxWidth: 360,
                  maxHeight: 400,
                  overflow: "auto",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                  zIndex: 100,
                  padding: "4px 0",
                }}
              >
                {outline.map((item, i) => (
                  <div
                    key={i}
                    onClick={() => handleOutlineClick(item.pageNumber)}
                    style={{
                      padding: "3px 10px",
                      paddingLeft: 10 + item.depth * 16,
                      fontSize: 11,
                      cursor: "pointer",
                      color: item.pageNumber === pageNumber ? "var(--accent)" : "var(--text)",
                      background: item.pageNumber === pageNumber ? "var(--bg-hover)" : "transparent",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={item.title}
                  >
                    {item.title}
                  </div>
                ))}
              </div>
            )}
          </span>
        )}

        {/* Watch indicator */}
        <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
        <Tooltip content={watching ? t("Live sync active") : t("Not watching")}>
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: watching ? "#4ade80" : "var(--border)",
                display: "inline-block",
                boxShadow: watching ? "0 0 4px #4ade80" : "none",
              }}
            />
            {watching ? t("live") : t("static")}
          </span>
        </Tooltip>
      </div>

      {/* PDF content area */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: 16,
        }}
      >
        {error ? (
          <div style={{ color: "#f87171", fontSize: 13, marginTop: 40 }}>{error}</div>
        ) : (
          <Document
            file={src}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={() => {
              if (!error) toast.show({ kind: "error", message: t("Failed to load file") });
              setError(t("Failed to load PDF"));
            }}
            loading={
              <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 40 }}>
                {t("Loading...")}
              </div>
            }
          >
            {/* Preload previous page (hidden) */}
            {numPages > 0 && pageNumber > 1 && (
              <div style={{ display: "none" }}>
                <Page
                  pageNumber={pageNumber - 1}
                  scale={effectiveScale}
                />
              </div>
            )}
            {/* Current page */}
            <Page
              key={`${src}-p${pageNumber}`}
              pageNumber={pageNumber}
              onLoadSuccess={onPageLoadSuccess}
              onRenderError={() => setError(t("Failed to render PDF page"))}
              scale={effectiveScale}
            />
            {/* Preload next page (hidden) */}
            {numPages > 0 && pageNumber < numPages && (
              <div style={{ display: "none" }}>
                <Page
                  pageNumber={pageNumber + 1}
                  scale={effectiveScale}
                />
              </div>
            )}
          </Document>
        )}
      </div>
    </div>
  );
}

export function FileViewer({ filePath, cwd }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} />;
  }
  if (isExcalidrawPath(filePath)) {
    return <ExcalidrawViewer filePath={filePath} cwd={cwd} />;
  }
  if (isPdfPath(filePath)) {
    return <PdfViewer filePath={filePath} cwd={cwd} />;
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} />;
}

function TextFileViewer({ filePath, cwd }: Props) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<FileData | null>(null);
  const [prevContent, setPrevContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [viewMode, setViewMode] = useState<"source" | "diff">("source");
  const [wrapLines, setWrapLines] = useState(false);
  const [watching, setWatching] = useState(false);
  const [changeCount, setChangeCount] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [externalChangeWhileEditing, setExternalChangeWhileEditing] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const editingRef = useRef(false);

  // Resolve raw markdown image src → final URL. Pass-through for external/data
  // URLs and already-rewritten /api/files/... paths; rewrite relative paths
  // against the markdown file's directory.
  const resolveSrc = useCallback((raw: string): string => {
    if (/^(https?:|data:|blob:|\/api\/files\/)/i.test(raw)) {
      return raw;
    }
    const resolved = resolveRelativePath(raw, filePath);
    return `/api/files/${encodeFilePathForApi(resolved)}?type=read`;
  }, [filePath]);

  // Gallery of every image reference in the markdown content, for lightbox
  // prev/next navigation. Recomputed only when the source or path changes.
  const gallery = useMemo(
    () => (data?.language === "markdown" ? extractImageGallery(data.content, resolveSrc) : []),
    [data?.content, data?.language, resolveSrc],
  );

  const fetchContent = useCallback((filePath: string, isRefresh = false) => {
    const encoded = encodeFilePathForApi(filePath);
    return fetch(`/api/files/${encoded}?type=read`)
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (d.error) {
          setError(d.error);
          return null;
        }
        if (isRefresh) {
          setData((prev) => {
            if (prev) setPrevContent(prev.content);
            return d;
          });
          setChangeCount((c) => c + 1);
        } else {
          setData(d);
        }
        return d;
      })
      .catch((e) => {
        setError(String(e));
        return null;
      });
  }, []);

  const handleEdit = useCallback(() => {
    if (!data) return;
    setEditContent(data.content);
    setExternalChangeWhileEditing(false);
    editingRef.current = true;
    setIsEditing(true);
  }, [data]);

  const handleCancel = useCallback(() => {
    editingRef.current = false;
    setIsEditing(false);
    setExternalChangeWhileEditing(false);
    // Reload from file to discard any local edits
    fetchContent(filePath);
  }, [filePath, fetchContent]);

  const handleSave = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    try {
      const encoded = encodeFilePathForApi(filePath);
      const res = await fetch(`/api/files/${encoded}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      // Optimistic local update — avoids full re-fetch
      setData({ ...data, content: editContent, size: new Blob([editContent]).size });
      setPrevContent(data.content);
      setChangeCount((c) => c + 1);
      editingRef.current = false;
      setIsEditing(false);
      setExternalChangeWhileEditing(false);
      toast.show({ kind: "success", message: t("File saved") });
    } catch (e) {
      console.error("Text file save failed", e);
      toast.show({ kind: "error", message: e instanceof Error && e.message ? e.message : t("Failed to save file") });
    } finally {
      setSaving(false);
    }
  }, [data, editContent, filePath, t, toast]);

  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      setEditContent((prev) => prev.substring(0, start) + "  " + prev.substring(end));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    } else if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  // Initial load + SSE watch setup
  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setPrevContent(null);
    setPreviewMode(false);
    setViewMode("source");
    setWrapLines(false);
    setChangeCount(0);
    setWatching(false);
    setIsEditing(false);
    setExternalChangeWhileEditing(false);
    setLightboxIndex(null);
    editingRef.current = false;

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    fetchContent(filePath).then((d) => {
      if (d?.language === "markdown") setPreviewMode(true);
    }).finally(() => setLoading(false));

    // Set up SSE watch
    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
    });

    es.addEventListener("change", () => {
      if (editingRef.current) {
        setExternalChangeWhileEditing(true);
      } else {
        fetchContent(filePath, true);
      }
    });

    es.addEventListener("error", () => {
      setWatching(false);
    });

    es.onerror = () => {
      setWatching(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, fetchContent]);

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("Loading...")}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!data) return null;

  const isHtml = data.language === "html";
  const isMarkdown = data.language === "markdown";
  const lines = data.content.split("\n");
  const hasDiff = prevContent !== null && prevContent !== data.content;
  const isDirty = editContent !== data.content;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <Tooltip content={filePath}><span style={{ fontFamily: "var(--font-mono)" }}>
          {getRelativeFilePath(filePath, cwd)}
        </span></Tooltip>
        <span style={{ marginLeft: "auto" }}>{data.language}</span>

        {isEditing ? (
          <>
            {isDirty && <span style={{ color: "#fbbf24", fontWeight: 600 }}>● unsaved</span>}
            {externalChangeWhileEditing && (
              <Tooltip content={t("File changed externally. Save to overwrite or Cancel to reload.")}>
                <span style={{ color: "#f87171", fontWeight: 600 }}>⚠ external</span>
              </Tooltip>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              style={{
                padding: "2px 10px", fontSize: 11, fontWeight: 600,
                cursor: saving || !isDirty ? "default" : "pointer",
                background: isDirty ? "var(--accent)" : "var(--bg-hover)",
                color: isDirty ? "#fff" : "var(--text-muted)",
                border: "1px solid var(--border)", borderRadius: 5,
                opacity: saving || !isDirty ? 0.5 : 1,
              }}
            >
              {saving ? t("Saving...") : t("Save")}
            </button>
            <button
              onClick={handleCancel}
              style={{
                padding: "2px 10px", fontSize: 11, cursor: "pointer",
                background: "var(--bg-hover)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 5,
              }}
            >
              {t("Cancel")}
            </button>
          </>
        ) : (
          <>
            {viewMode === "source" && <span>{lines.length} {t("lines")}</span>}
            <span>{formatSize(data.size)}</span>

            {/* Live watch indicator */}
            <Tooltip content={watching ? t("Live sync active") : t("Not watching")}>
            <span
              style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
            >
              <span
                style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: watching ? "#4ade80" : "var(--border)",
                  display: "inline-block",
                  boxShadow: watching ? "0 0 4px #4ade80" : "none",
                }}
              />
              {watching ? t("live") : t("static")}
            </span>
            </Tooltip>

            {/* Diff / Source toggle — shown only when there are changes */}
            {hasDiff && (
              <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
                <button
                  onClick={() => setViewMode("source")}
                  style={{
                    padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                    background: viewMode === "source" ? "var(--bg-selected)" : "var(--bg-hover)",
                    color: viewMode === "source" ? "var(--text)" : "var(--text-muted)",
                    fontWeight: viewMode === "source" ? 600 : 400,
                  }}
                >
                  {t("Source")}
                </button>
                <button
                  onClick={() => setViewMode("diff")}
                  style={{
                    padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                    background: viewMode === "diff" ? "var(--bg-selected)" : "var(--bg-hover)",
                    color: viewMode === "diff" ? "var(--text)" : "var(--text-muted)",
                    fontWeight: viewMode === "diff" ? 600 : 400,
                  }}
                >
                  {t("Diff")} {changeCount > 0 && <span style={{ color: "#4ade80", marginLeft: 2 }}>+{changeCount}</span>}
                </button>
              </div>
            )}

            {/* Word wrap toggle */}
            {viewMode === "source" && !previewMode && (
              <Tooltip content={wrapLines ? t("Disable word wrap") : t("Enable word wrap")}>
              <button
                onClick={() => setWrapLines((v) => !v)}
                style={{
                  padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  background: wrapLines ? "var(--bg-selected)" : "var(--bg-hover)",
                  color: wrapLines ? "var(--text)" : "var(--text-muted)",
                  border: "1px solid var(--border)", borderRadius: 5,
                  fontWeight: wrapLines ? 600 : 400,
                }}
              >
                {t("wrap")}
              </button>
              </Tooltip>
            )}

            {/* HTML source/preview toggle */}
            {isHtml && viewMode === "source" && (
              <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
                <button
                  onClick={() => setPreviewMode(false)}
                  style={{
                    padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                    background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                    color: !previewMode ? "var(--text)" : "var(--text-muted)",
                    fontWeight: !previewMode ? 600 : 400,
                  }}
                >
                  {t("Code")}
                </button>
                <button
                  onClick={() => setPreviewMode(true)}
                  style={{
                    padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                    background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                    color: previewMode ? "var(--text)" : "var(--text-muted)",
                    fontWeight: previewMode ? 600 : 400,
                  }}
                >
                  {t("Preview")}
                </button>
              </div>
            )}

            {/* Markdown preview/raw toggle */}
            {isMarkdown && viewMode === "source" && (
              <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
                <button
                  onClick={() => setPreviewMode(true)}
                  style={{
                    padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                    background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                    color: previewMode ? "var(--text)" : "var(--text-muted)",
                    fontWeight: previewMode ? 600 : 400,
                  }}
                >
                  {t("Preview")}
                </button>
                <button
                  onClick={() => setPreviewMode(false)}
                  style={{
                    padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                    background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                    color: !previewMode ? "var(--text)" : "var(--text-muted)",
                    fontWeight: !previewMode ? 600 : 400,
                  }}
                >
                  {t("Raw")}
                </button>
              </div>
            )}

            {/* Edit button */}
            <button
              onClick={handleEdit}
              style={{
                padding: "2px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                background: "var(--bg-hover)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 5,
              }}
            >
              {t("Edit")}
            </button>
          </>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
        {isEditing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              resize: "none",
              padding: "12px 16px",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              lineHeight: 1.6,
              background: "var(--bg)",
              color: "var(--text)",
              outline: "none",
              tabSize: 2,
            }}
          />
        ) : viewMode === "diff" && hasDiff ? (
          <DiffView oldContent={prevContent!} newContent={data.content} language={data.language} />
        ) : isHtml && previewMode ? (
          <iframe
            srcDoc={data.content}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
          />
        ) : isMarkdown && previewMode ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "24px 32px", maxWidth: 800 }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: (props) => (
                  <MarkdownImage
                    {...props}
                    resolveSrc={resolveSrc}
                    onImageClick={(src) => {
                      const idx = gallery.findIndex((g) => g.src === src);
                      if (idx >= 0) setLightboxIndex(idx);
                    }}
                  />
                ),
              }}
            >
              {data.content}
            </ReactMarkdown>
          </div>
        ) : (
          <SyntaxHighlighter
            language={data.language === "text" ? "plaintext" : data.language}
            style={isDark ? vscDarkPlus : vs}
            showLineNumbers
            lineNumberStyle={{
              color: "var(--text-dim)",
              fontStyle: "normal",
              minWidth: "3em",
              paddingRight: "1em",
            }}
            customStyle={{
              margin: 0,
              padding: "12px 0",
              background: "var(--bg)",
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily: "var(--font-mono)",
              minHeight: "100%",
            }}
            codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
            wrapLongLines={wrapLines}
          >
            {data.content}
          </SyntaxHighlighter>
        )}
      </div>
      {lightboxIndex !== null && gallery.length > 0 && (
        <ImageLightbox
          images={gallery}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  );
}
