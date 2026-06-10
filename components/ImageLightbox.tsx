"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface ImageItem {
  alt: string;
  src: string;
}

// Extract every image reference from a markdown document. Pass an optional
// resolveSrc to rewrite raw src values (e.g. relative paths → /api/files/...);
// otherwise src is used as-is (e.g. for todo descriptions where the src is
// already an absolute /api/todo-images/... URL).
export function extractImageGallery(
  content: string,
  resolveSrc: (raw: string) => string = (s) => s,
): ImageItem[] {
  const re = /!\[([^\]]*)\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;
  const out: ImageItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ alt: m[1] ?? "", src: resolveSrc(m[2] ?? "") });
  }
  return out;
}

// Custom <img> for ReactMarkdown. Calls onImageClick with the resolved src.
export function MarkdownImage({ src, alt, resolveSrc, onImageClick }: {
  src?: string | Blob;
  alt?: string;
  resolveSrc: (raw: string) => string;
  onImageClick?: (finalSrc: string) => void;
}) {
  const { t } = useI18n();
  const [errored, setErrored] = useState(false);

  if (!src || typeof src !== "string") return null;
  const finalSrc = resolveSrc(src);
  const handleClick = onImageClick
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        onImageClick(finalSrc);
      }
    : undefined;

  if (errored) {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "4px 10px",
          border: "1px dashed var(--border)",
          borderRadius: 4,
          color: "var(--text-dim)",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          background: "var(--bg-panel)",
        }}
      >
        [image: {alt || t("Failed to load image")}]
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={finalSrc}
      alt={alt ?? ""}
      onClick={handleClick}
      onError={() => setErrored(true)}
      style={{ maxWidth: "100%", cursor: onImageClick ? "zoom-in" : "default" }}
    />
  );
}

// Full-screen image lightbox. Click an image in the markdown preview to open
// it; arrow keys / on-screen arrows navigate the gallery; +/-/wheel zoom; drag
// to pan when zoomed; Esc or click backdrop to close.
export function ImageLightbox({ images, index, onClose, onIndexChange }: {
  images: ImageItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const { t } = useI18n();
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const current = images[index];
  const hasMultiple = images.length > 1;
  const canPrev = hasMultiple;
  const canNext = hasMultiple;

  // Reset zoom/pan and error state when navigating to a different image
  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    setNaturalSize(null);
    setLoadError(false);
  }, [index]);

  // Lock body scroll while the lightbox is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const editable = document.activeElement?.getAttribute("contenteditable");
      if (editable === "true" || editable === "") return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && canPrev) {
        e.preventDefault();
        onIndexChange((index - 1 + images.length) % images.length);
      } else if (e.key === "ArrowRight" && canNext) {
        e.preventDefault();
        onIndexChange((index + 1) % images.length);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(8, s * 1.25));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale((s) => Math.max(0.1, s * 0.8));
      } else if (e.key === "0") {
        e.preventDefault();
        setScale(1);
        setTx(0);
        setTy(0);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, images.length, canPrev, canNext, onClose, onIndexChange]);

  // Non-passive wheel listener so we can preventDefault page scroll while zooming
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setScale((s) => Math.max(0.1, Math.min(8, s * factor)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Window-level mousemove/mouseup so drag continues even when the cursor
  // leaves the image
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = dragStartRef.current;
      if (!s) return;
      setTx(s.tx + (e.clientX - s.x));
      setTy(s.ty + (e.clientY - s.y));
    };
    const onUp = () => {
      setDragging(false);
      dragStartRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  function resetZoom() {
    setScale(1);
    setTx(0);
    setTy(0);
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (scale <= 1) return;
    e.preventDefault();
    setDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, tx, ty };
  }

  const zoomLabel = scale === 1 ? t("Fit") : `${Math.round(scale * 100)}%`;

  const btnBase: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.9)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 5,
    fontFamily: "var(--font-mono)",
    lineHeight: 1.2,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.9)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top toolbar */}
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
        {hasMultiple && (
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
            {index + 1} / {images.length}
          </span>
        )}
        {current.alt && (
          <span style={{ color: "rgba(255,255,255,0.6)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {current.alt}
          </span>
        )}
        {naturalSize && (
          <span style={{ marginLeft: "auto", color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)" }}>
            {naturalSize.w} × {naturalSize.h}
          </span>
        )}
        <button onClick={onClose} style={btnBase} title={t("Close")}>
          ✕
        </button>
      </div>

      {/* Image area — click on backdrop closes */}
      <div
        ref={containerRef}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {loadError ? (
          <div style={{ color: "#f87171", fontSize: 13 }}>{t("Failed to load image")}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.src}
            alt={current.alt}
            draggable={false}
            onLoad={(e) => {
              setNaturalSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
            }}
            onError={() => setLoadError(true)}
            onMouseDown={handleMouseDown}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              transition: dragging ? "none" : "transform 0.1s ease-out",
              cursor: scale > 1 ? (dragging ? "grabbing" : "grab") : "default",
              userSelect: "none",
            }}
          />
        )}
      </div>

      {/* Bottom toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "8px 16px",
          background: "rgba(0, 0, 0, 0.5)",
          color: "rgba(255,255,255,0.9)",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => onIndexChange((index - 1 + images.length) % images.length)}
          disabled={!canPrev}
          style={{ ...btnBase, opacity: canPrev ? 1 : 0.35, cursor: canPrev ? "pointer" : "default" }}
        >
          ‹
        </button>
        <span style={{ width: 1, height: 18, background: "rgba(255,255,255,0.2)", margin: "0 4px" }} />
        <button
          onClick={() => setScale((s) => Math.max(0.1, s * 0.8))}
          style={btnBase}
        >
          −
        </button>
        <button
          onClick={resetZoom}
          style={{ ...btnBase, minWidth: 52, fontWeight: scale === 1 ? 700 : 400 }}
        >
          {zoomLabel}
        </button>
        <button
          onClick={() => setScale((s) => Math.min(8, s * 1.25))}
          style={btnBase}
        >
          +
        </button>
        <span style={{ width: 1, height: 18, background: "rgba(255,255,255,0.2)", margin: "0 4px" }} />
        <button
          onClick={() => onIndexChange((index + 1) % images.length)}
          disabled={!canNext}
          style={{ ...btnBase, opacity: canNext ? 1 : 0.35, cursor: canNext ? "pointer" : "default" }}
        >
          ›
        </button>
      </div>
    </div>
  );
}
