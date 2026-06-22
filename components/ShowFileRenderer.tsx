"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { useI18n } from "@/hooks/useI18n";
import { ImageLightbox } from "@/components/ImageLightbox";
import { AudioPlayer } from "@/components/AudioPlayer";
import { MermaidBlock } from "@/components/MermaidBlock";
import { SvgBlock } from "@/components/SvgBlock";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";

// Heavy client-only component; lazy-load with SSR off so show_file
// doesn't pull the excalidraw bundle until an .excalidraw file is shown.
const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false },
);

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
const EXCALIDRAW_EXTS = new Set(["excalidraw"]);
const MARKDOWN_EXTS = new Set(["md", "markdown"]);

type Category = "image" | "video" | "audio" | "pdf" | "html" | "excalidraw" | "markdown" | "text" | "binary";

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
  if (EXCALIDRAW_EXTS.has(ext)) return "excalidraw";
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

  // One lightbox at a time. Image uses the rich ImageLightbox (zoom/pan);
  // HTML and Excalidraw use a generic FullscreenOverlay that wraps the
  // rendered content at viewport size.
  const [lightbox, setLightbox] = useState<
    | { kind: "image"; src: string; alt: string }
    | { kind: "content"; title: string; node: React.ReactNode }
    | null
  >(null);

  if (category === "image") {
    const alt = filePath;
    return (
      <>
        <div
          style={{
            position: "relative",
            display: "block",
            maxWidth: "100%",
            border: "1px solid var(--border)",
            borderRadius: 6,
            overflow: "hidden",
            background: "var(--bg)",
            lineHeight: 0,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={alt}
            loading="lazy"
            style={{
              display: "block",
              maxWidth: "100%",
              maxHeight: "60vh",
            }}
          />
          <ExpandButton onClick={() => setLightbox({ kind: "image", src: url, alt })} />
        </div>
        {lightbox?.kind === "image" && (
          <ImageLightbox
            images={[{ src: lightbox.src, alt: lightbox.alt }]}
            index={0}
            onClose={() => setLightbox(null)}
            onIndexChange={() => {}}
          />
        )}
      </>
    );
  }

  if (category === "video") {
    return (
      <video
        controls
        autoPlay
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
    return <AudioPlayer src={url} title={filePath} />;
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
    return (
      <>
        <HtmlContent
          url={url}
          onExpand={(node, title) => setLightbox({ kind: "content", title, node })}
        />
        {lightbox?.kind === "content" && (
          <FullscreenOverlay title={lightbox.title} onClose={() => setLightbox(null)}>
            {lightbox.node}
          </FullscreenOverlay>
        )}
      </>
    );
  }

  if (category === "excalidraw") {
    return (
      <>
        <ExcalidrawContent
          url={url}
          onExpand={(node, title) => setLightbox({ kind: "content", title, node })}
        />
        {lightbox?.kind === "content" && (
          <FullscreenOverlay title={lightbox.title} onClose={() => setLightbox(null)}>
            {lightbox.node}
          </FullscreenOverlay>
        )}
      </>
    );
  }

  if (category === "markdown") {
    return <MarkdownContent url={url} />;
  }

  if (category === "text") {
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

function HtmlContent({ url, onExpand }: { url: string; onExpand: (node: React.ReactNode, title: string) => void }) {
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

  // `key="thumb"` vs `key="fullscreen"` forces a fresh iframe when expanding,
  // so the fullscreen instance re-runs scripts in the new layout.
  return (
    <div
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        background: "#fff",
      }}
    >
      <iframe
        key="thumb"
        title="html-content"
        srcDoc={state.content}
        sandbox="allow-scripts"
        style={{
          display: "block",
          width: "100%",
          height: "70vh",
          border: "none",
        }}
      />
      <ExpandButton
        onClick={() =>
          onExpand(
            <iframe
              key="fullscreen"
              title="html-content-fullscreen"
              srcDoc={state.content}
              sandbox="allow-scripts"
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                border: "none",
                background: "#fff",
              }}
            />,
            t("html"),
          )
        }
      />
    </div>
  );
}

function MarkdownContent({ url }: { url: string }) {
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

  // Memoize the components map so ReactMarkdown doesn't see a new
  // identity on every parent re-render. Without this, the new
  // `code` closure produces a new <MermaidBlock> element on every
  // render, which can cause the mermaid subtree to remount and
  // re-parse — visible as flicker and scroll-position jumps.
  const components = useMemo<Components>(() => {
    const codeOverride: Components["code"] = ((props: { className?: string; children?: React.ReactNode }) => {
      const className = props.className;
      const children = props.children;
      const lang = className?.replace("language-", "") ?? "";
      const raw = String(children ?? "");
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock && lang === "mermaid") {
        // Stable key keeps the MermaidBlock instance alive across
        // re-renders even if the surrounding tree restructures.
        return <MermaidBlock key={raw} code={raw.replace(/\n$/, "")} />;
      }
      if (isBlock && lang === "svg") {
        // Stable key keeps the SvgBlock instance alive across
        // re-renders even if the surrounding tree restructures.
        return <SvgBlock key={raw} code={raw.replace(/\n$/, "")} />;
      }
      return <code className={className}>{children}</code>;
    }) as Components["code"];
    const preOverride: Components["pre"] = (({ children }: { children?: React.ReactNode }) => <>{children}</>) as Components["pre"];
    return { code: codeOverride, pre: preOverride };
  }, []);

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
    <div
      className="markdown-body"
      style={{
        padding: "10px 12px",
        color: "var(--text)",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 13,
        lineHeight: 1.6,
        maxHeight: "60vh",
        overflow: "auto",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {state.content}
      </ReactMarkdown>
    </div>
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

function ExcalidrawContent({ url, onExpand }: { url: string; onExpand: (node: React.ReactNode, title: string) => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; initialData: object }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    Promise.all([
      fetch(url).then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ content: string }>;
      }),
      import("@excalidraw/excalidraw").then((m) => m.restore),
    ])
      .then(([data, restore]) => {
        if (cancelled) return;
        try {
          const raw = JSON.parse(data.content);
          const restored = restore(
            { elements: raw.elements, appState: raw.appState, files: raw.files },
            null,
            null,
          ) as Record<string, unknown> & { appState?: Record<string, unknown> };
          // Ensure collaborators is a Map (matches FileViewer robustness fix)
          if (restored.appState) {
            const collab = restored.appState.collaborators;
            if (!(collab instanceof Map)) {
              restored.appState.collaborators = new Map(
                Array.isArray(collab) ? collab : Object.entries(collab ?? {}),
              );
            }
          }
          setState({ kind: "ready", initialData: restored });
        } catch {
          setState({ kind: "error", message: t("Invalid Excalidraw file") });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message });
      });

    return () => { cancelled = true; };
  }, [url, t]);

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

  // The fullscreen instance uses a different `key` so Excalidraw re-measures
  // its canvas against the new (viewport-sized) parent container.
  return (
    <div
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "block",
          width: "100%",
          height: "70vh",
          background: "#fff",
        }}
      >
        <Excalidraw
          key="excalidraw-thumb"
          initialData={state.initialData}
          viewModeEnabled
          zenModeEnabled
        />
      </div>
      <ExpandButton
        onClick={() =>
          onExpand(
            <Excalidraw
              key="excalidraw-fullscreen"
              initialData={state.initialData}
              viewModeEnabled
              zenModeEnabled
            />,
            t("excalidraw"),
          )
        }
      />
    </div>
  );
}

// Corner button used to open the lightbox/overlay from image, HTML, and
// Excalidraw previews. Sits in the top-right of its `position:relative`
// parent and only becomes fully opaque on hover so it doesn't fight the
// content underneath.
function ExpandButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("Click to expand")}
      title={t("Click to expand")}
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        width: 26,
        height: 26,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        background: "rgba(0, 0, 0, 0.55)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: 5,
        fontSize: 14,
        lineHeight: 1,
        opacity: 0.55,
        transition: "opacity 0.1s ease-out, background 0.1s ease-out",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "1";
        e.currentTarget.style.background = "rgba(0, 0, 0, 0.8)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = "0.55";
        e.currentTarget.style.background = "rgba(0, 0, 0, 0.55)";
      }}
    >
      {/* simple magnifier glyph */}
      <span aria-hidden="true">⛶</span>
    </button>
  );
}

// Viewport-sized overlay used to expand non-image content (HTML iframe,
// Excalidraw scene) fullscreen. Esc or backdrop click closes. The child
// node is mounted fresh on each open via the caller's `key` strategy.
function FullscreenOverlay({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.9)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          background: "rgba(0, 0, 0, 0.5)",
          color: "rgba(255,255,255,0.9)",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{title}</span>
        <button
          onClick={onClose}
          title={t("Close")}
          style={{
            marginLeft: "auto",
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.9)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 5,
            fontFamily: "var(--font-mono)",
            lineHeight: 1.2,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>
    </div>
  );
}