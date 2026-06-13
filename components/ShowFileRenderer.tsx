"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";

interface Props {
  filePath: string;
  /** Session working directory; used to resolve relative paths. */
  cwd?: string;
}

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "ogg", "ogv", "m4v"]);
const AUDIO_EXTS = new Set([
  "mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm",
]);
const PDF_EXTS = new Set(["pdf"]);
const HTML_EXTS = new Set(["html", "htm"]);
const MARKDOWN_EXTS = new Set(["md", "markdown"]);

type Category = "image" | "video" | "audio" | "pdf" | "html" | "markdown" | "text" | "binary";

function getExt(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : "";
}

function categorize(filePath: string): Category {
  const ext = getExt(filePath);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (PDF_EXTS.has(ext)) return "pdf";
  if (HTML_EXTS.has(ext)) return "html";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  return "text";
}

function fileApiUrl(filePath: string): string {
  return `/api/files/${encodeFilePathForApi(filePath)}?type=read`;
}

export function ShowFileRenderer({ filePath, cwd }: Props) {
  const { t } = useI18n();
  // Resolve relative paths against cwd so the URL points to the right file.
  const isAbsolute = filePath.startsWith("/")
    || /^[a-zA-Z]:[\\/]/.test(filePath)
    || filePath.startsWith("\\\\");
  const resolved = isAbsolute || !cwd ? filePath : joinFilePath(cwd, filePath);
  const ext = getExt(resolved);
  const category = categorize(resolved);
  const url = fileApiUrl(resolved);

  if (category === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={filePath}
        loading="lazy"
        style={{
          display: "block",
          maxWidth: "100%",
          maxHeight: "60vh",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      />
    );
  }

  if (category === "video") {
    return (
      <video
        controls
        src={url}
        preload="metadata"
        style={{
          display: "block",
          maxWidth: "100%",
          maxHeight: "60vh",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "#000",
        }}
      />
    );
  }

  if (category === "audio") {
    return (
      <audio
        controls
        src={url}
        preload="metadata"
        style={{ display: "block", width: "100%" }}
      />
    );
  }

  if (category === "pdf") {
    return (
      <iframe
        src={url}
        title={filePath}
        sandbox="allow-same-origin"
        style={{
          display: "block",
          width: "100%",
          height: "70vh",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg)",
        }}
      />
    );
  }

  if (category === "html") {
    return <HtmlContent url={url} />;
  }

  if (category === "markdown" || category === "text") {
    return <TextContent url={url} ext={ext} />;
  }

  return (
    <div
      style={{
        padding: "8px 10px",
        color: "var(--text-dim)",
        fontSize: 12,
        fontStyle: "italic",
        border: "1px dashed var(--border)",
        borderRadius: 6,
      }}
    >
      {t("Unsupported file type: {ext}").replace("{ext}", ext || "(none)")}
    </div>
  );
}

function HtmlContent({ url }: { url: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; content: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ content: string }>;
      })
      .then((data) => {
        if (cancelled) return;
        setState({ kind: "ready", content: data.content });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message });
      });
    return () => { cancelled = true; };
  }, [url]);

  if (state.kind === "loading") {
    return (
      <div style={{ padding: "8px 10px", color: "var(--text-dim)", fontSize: 12 }}>
        {t("Loading…")}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        style={{
          padding: "8px 10px",
          color: "#f87171",
          fontSize: 12,
          border: "1px solid rgba(248,113,113,0.3)",
          borderRadius: 6,
          background: "rgba(248,113,113,0.05)",
        }}
      >
        {t("Failed to load file")}: {state.message}
      </div>
    );
  }
  return (
    <iframe
      title="html-content"
      srcDoc={state.content}
      sandbox="allow-scripts"
      style={{
        display: "block",
        width: "100%",
        height: "70vh",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "#fff",
      }}
    />
  );
}

function TextContent({ url, ext }: { url: string; ext: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; content: string; language: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ content: string; language: string }>;
      })
      .then((data) => {
        if (cancelled) return;
        setState({ kind: "ready", content: data.content, language: data.language });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message });
      });
    return () => { cancelled = true; };
  }, [url]);

  if (state.kind === "loading") {
    return (
      <div style={{ padding: "8px 10px", color: "var(--text-dim)", fontSize: 12 }}>
        {t("Loading…")}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        style={{
          padding: "8px 10px",
          color: "#f87171",
          fontSize: 12,
          border: "1px solid rgba(248,113,113,0.3)",
          borderRadius: 6,
          background: "rgba(248,113,113,0.05)",
        }}
      >
        {t("Failed to load file")}: {state.message}
      </div>
    );
  }

  return (
    <pre
      style={{
        margin: 0,
        padding: "8px 10px",
        color: "var(--text)",
        fontSize: 12,
        lineHeight: 1.5,
        overflow: "auto",
        maxHeight: "60vh",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontFamily: "var(--font-mono)",
        whiteSpace: "pre",
        wordBreak: "normal",
      }}
    >
      <span style={{ color: "var(--text-dim)", userSelect: "none", marginRight: 8 }}>
        .{ext} ({state.language})
      </span>
      {state.content}
    </pre>
  );
}