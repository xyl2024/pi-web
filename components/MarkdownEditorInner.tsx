"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  defaultValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  placeholder?: string;
  minHeight?: number;
  className?: string;
}

// All colors come from CSS variables defined in app/globals.css so the editor
// follows the active theme (default / midnight / synthwave / forest / sepia)
// without per-theme code. Do not hard-code hex values here.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, color: "var(--accent)", fontWeight: "700" },
  { tag: t.heading2, color: "var(--accent)", fontWeight: "600" },
  { tag: t.heading3, color: "var(--accent)", fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], color: "var(--accent)", fontWeight: "500" },
  { tag: t.strong, fontWeight: "700", color: "var(--text)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--text-muted)" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--accent)" },
  { tag: t.monospace, color: "var(--text)", backgroundColor: "var(--bg-subtle)" },
  { tag: t.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--text)" },
  { tag: t.meta, color: "var(--text-dim)" },
  { tag: t.processingInstruction, color: "var(--text-dim)" },
  { tag: t.contentSeparator, color: "var(--text-dim)" },
]);

const baseTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--text)",
      fontSize: "12px",
      fontFamily: "var(--font-mono)",
    },
    ".cm-content": { padding: "6px 4px", caretColor: "var(--text)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--bg-selected)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--text-dim)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)" },
    ".cm-searchMatch": { backgroundColor: "var(--bg-selected)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent)" },
  },
  { dark: false },
);

const TOOLBAR_HEIGHT = 28;
const DIVIDER_HEIGHT = 4;
const MIN_PANE = 60;
const PREVIEW_MIN = 40;
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;

export function MarkdownEditorInner({
  defaultValue,
  onSave,
  onCancel,
  placeholder,
  minHeight = 240,
  className,
}: Props) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const [previewText, setPreviewText] = useState(defaultValue);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [splitPx, setSplitPx] = useState<number | null>(null);

  const handleSave = useCallback(() => {
    const v = viewRef.current?.state.doc.toString() ?? "";
    onSave(v);
  }, [onSave]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  // Mount CodeMirror once. Handlers come from the initial closure; we don't
  // want re-running this effect on every parent re-render.
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: defaultValue,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(mdHighlight),
        baseTheme,
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { handleSave(); return true; } },
          { key: "Mod-Enter", preventDefault: true, run: () => { handleSave(); return true; } },
          { key: "Escape", preventDefault: true, run: () => { handleCancel(); return true; } },
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            // Debounce the live preview to avoid re-rendering on every keystroke.
            const doc = update.state.doc.toString();
            setTimeout(() => {
              if (viewRef.current && viewRef.current.state.doc.toString() === doc) {
                setPreviewText(doc);
              }
            }, 150);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize split position to 1/3 (editor smaller, preview larger — the
  // preview is the user's primary feedback loop while typing markdown).
  useEffect(() => {
    if (splitPx === null && containerRef.current) {
      const totalH = Math.max(minHeight, containerRef.current.clientHeight || minHeight);
      const usable = totalH - TOOLBAR_HEIGHT - DIVIDER_HEIGHT - PREVIEW_MIN;
      setSplitPx(Math.max(MIN_PANE, Math.floor(usable * (1 / 3)) + PREVIEW_MIN));
    }
  }, [minHeight, splitPx]);

  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startY = e.clientY;
    const startSplit = splitPx ?? Math.floor(rect.height / 3);
    const totalH = rect.height;
    const minAllowed = Math.max(MIN_PANE, (totalH - TOOLBAR_HEIGHT - DIVIDER_HEIGHT) * RATIO_MIN);
    const maxAllowed = (totalH - TOOLBAR_HEIGHT - DIVIDER_HEIGHT) * RATIO_MAX;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const next = Math.min(maxAllowed, Math.max(minAllowed, startSplit + dy));
      setSplitPx(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const editorHeight = previewCollapsed
    ? `calc(100% - ${TOOLBAR_HEIGHT}px)`
    : `${splitPx ?? Math.max(MIN_PANE, minHeight / 3)}px`;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight,
        marginLeft: 22,
        border: "1px solid var(--accent)",
        borderRadius: 3,
        overflow: "hidden",
        background: "var(--bg-panel)",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: TOOLBAR_HEIGHT,
          padding: "0 6px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          flexShrink: 0,
        }}
      >
        <span style={{ flex: 1 }}>{t("Markdown supported")}</span>
        <button
          type="button"
          onClick={() => setPreviewCollapsed((v) => !v)}
          style={{
            background: "none",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            fontSize: 11,
            padding: "1px 8px",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {previewCollapsed ? t("Show preview") : t("Hide preview")}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          style={{
            background: "none",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            fontSize: 11,
            padding: "1px 8px",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          style={{
            background: "var(--accent)",
            border: "none",
            color: "var(--bg)",
            fontSize: 11,
            padding: "1px 10px",
            borderRadius: 3,
            cursor: "pointer",
            fontWeight: 500,
            fontFamily: "inherit",
          }}
        >
          {t("Save")}
        </button>
      </div>

      {/* CodeMirror host */}
      <div
        ref={hostRef}
        style={{
          height: editorHeight,
          minHeight: MIN_PANE,
          overflow: "auto",
          flexShrink: 0,
        }}
      />

      {/* Draggable divider */}
      {!previewCollapsed && (
        <div
          onMouseDown={onDividerMouseDown}
          style={{
            height: DIVIDER_HEIGHT,
            cursor: "row-resize",
            background: "var(--border)",
            flexShrink: 0,
          }}
        />
      )}

      {/* Live preview */}
      {!previewCollapsed && (
        <div
          style={{
            flex: 1,
            minHeight: PREVIEW_MIN,
            overflow: "auto",
            padding: "6px 8px",
            background: "var(--bg)",
          }}
        >
          {previewText.trim() ? (
            <div className="markdown-body" style={{ fontSize: 12 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {previewText}
              </ReactMarkdown>
            </div>
          ) : (
            <span
              style={{
                color: "var(--text-dim)",
                fontStyle: "italic",
                fontSize: 11,
              }}
            >
              {placeholder ?? t("Add description...")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
