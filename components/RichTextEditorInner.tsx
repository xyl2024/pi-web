"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import { useEditor, EditorContent, Editor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { TableKit } from "@tiptap/extension-table";
import { createLowlight, common } from "lowlight";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { BubbleMenu } from "@tiptap/react/menus";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";
import { uploadTodoImages, extractImageFiles, extractClipboardImageFiles } from "@/lib/todo-image-upload";
import type { ImageUploader } from "@/components/RichTextEditor";
import { buildDescriptionSanitizeConfig } from "@/lib/description-sanitize";
import { TextColorPicker, TextColorToolbarButton, applyEditorColor } from "@/components/TextColorPicker";

interface Props {
  defaultValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  /** Called with the current sanitized HTML on every change. Lets the parent
   *  flush unsaved edits during page unload (pagehide + keepalive). */
  onChange?: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  className?: string;
  uploadImages?: ImageUploader;
}

// Lowlight with the common grammar set + an explicit empty "mermaid" entry so
// the language picker can render Mermaid code blocks. The actual Mermaid
// rendering happens in the read-only view (TodoDescriptionView → MermaidBlock);
// inside the editor Mermaid just shows as a highlighted <pre> with the source
// text, which matches what Tiptap's CodeBlockLowlight does for any registered
// language whose grammar is missing.
const lowlight = createLowlight(common);
try {
  lowlight.register("mermaid", common.javascript ?? (() => null));
} catch {
  // best-effort — if registration fails the language name still appears in
  // the picker and the block falls back to plain rendering
}

// Sanitize config for both the seed (mount) and save passes. Shared with the
// server-side allowlist via lib/description-sanitize.ts — `allowStyle: true`
// so `<span style="color: #rrggbb">` round-trips intact (the helper's hook
// rewrites every other style property out before this point).
const SANITIZE_CONFIG = buildDescriptionSanitizeConfig({ allowStyle: true });

export function RichTextEditorInner({
  defaultValue,
  onSave,
  onCancel,
  onChange,
  placeholder,
  minHeight = 240,
  className,
  uploadImages,
}: Props) {
  const { t } = useI18n();
  const { show: showToast } = useToast();
  const editorRef = useRef<Editor | null>(null);
  // Caller-supplied uploader wins; otherwise the editor falls back to the
  // todo-images endpoint so existing callers (TodoPanel) keep working.
  const uploaderRef = useRef<ImageUploader>(uploadImages ?? uploadTodoImages);
  uploaderRef.current = uploadImages ?? uploadTodoImages;

  // Capture the seed at mount so the unmount-save diff isn't fooled by a
  // later defaultValue prop change (defensive — in practice defaultValue is
  // stable for the lifetime of the editor).
  const initialSeedRef = useRef(defaultValue);
  // Latest sanitized HTML, updated on every transaction. Read by the unmount
  // cleanup so we can flush an unsaved edit when the panel unmounts mid-edit
  // (tab close / tab switch / React-driven page tear-down).
  const latestHtmlRef = useRef(defaultValue);
  // Explicit Save / Cancel both suppress the unmount-save path so we don't
  // double-fire onUpdate or override a deliberate Cancel.
  const savedRef = useRef(false);
  const cancelledRef = useRef(false);
  // Keep the latest onSave in a ref so the unmount cleanup can call it
  // without re-running on every render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // Keep onChange in a ref for the same reason — the editor's `update`
  // listener closes over it via this ref so we don't re-subscribe per render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleSave = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const html = editor.getHTML();
    const safe = DOMPurify.sanitize(html, SANITIZE_CONFIG);
    savedRef.current = true;
    latestHtmlRef.current = safe;
    onSave(safe);
  }, [onSave]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    onCancel();
  }, [onCancel]);

  // Sanitize the seed HTML on mount so the editor never sees e.g. a
  // <script> tag the server somehow let through.
  const seed = useMemo(() => {
    if (!defaultValue) return "";
    try {
      return DOMPurify.sanitize(defaultValue, SANITIZE_CONFIG);
    } catch {
      return "";
    }
  }, [defaultValue]);

  const editor = useEditor({
    // immediatelyRender:false avoids a "Tiptap content rendered on the server"
    // warning in Next.js 16. The component itself is already loaded via a
    // dynamic({ ssr: false }) shim, but Tiptap 3 still needs the hint.
    immediatelyRender: false,
    content: seed,
    extensions: [
      StarterKit.configure({
        // Use our own CodeBlockLowlight (syntax highlight) instead of the
        // built-in codeBlock from StarterKit.
        codeBlock: false,
        // Customize the bundled Link to open in a new tab and never follow
        // clicks while editing.
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      Image.configure({
        allowBase64: false,
        inline: false,
        HTMLAttributes: { loading: "lazy" },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? t("Add description..."),
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlockLowlight.configure({ lowlight }),
      TableKit.configure({ table: { resizable: true } }),
      // Text color: TextStyle provides the <span style="…"> host schema,
      // Color provides the mark + setColor / unsetColor commands. Tiptap v3
      // doesn't bundle TextStyle in StarterKit, so it must be added
      // explicitly. `types: ["textStyle"]` (the default) keeps color marks
      // scoped to textStyle-marked spans — they don't leak into <p>/<pre>.
      TextStyle,
      Color,
    ],
    editorProps: {
      attributes: {
        spellcheck: "true",
        class: "tiptap-rich-text",
        // Editor styles (padding, font) live in globals.css under the
        // `.tiptap-rich-text` selector so the theme variables apply.
      },
      handlePaste(_view, event) {
        const files = extractClipboardImageFiles(event as ClipboardEvent);
        if (files.length === 0) return false;
        event.preventDefault();
        const editor = editorRef.current;
        if (!editor) return true;
        void uploadAndInsert(editor, files, showToast, t, uploaderRef.current);
        return true;
      },
      handleDrop(_view, event, _slice, moved) {
        if (moved) return false;
        const files = extractImageFiles((event as DragEvent).dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const editor = editorRef.current;
        if (!editor) return true;
        const coords = { left: (event as DragEvent).clientX, top: (event as DragEvent).clientY };
        void uploadAndInsert(editor, files, showToast, t, uploaderRef.current, coords);
        return true;
      },
    },
  });

  // Keep editorRef in sync with the latest editor instance so the
  // handlePaste / handleDrop closures (which capture the ref) stay current.
  useEffect(() => {
    editorRef.current = editor;
    if (editor) editor.commands.focus("end");
    return () => {
      editorRef.current = null;
    };
  }, [editor]);

  // Mirror the editor's HTML into latestHtmlRef and notify the parent on every
  // transaction. The ref is what the unmount cleanup reads; onChange lets the
  // parent run a keepalive fetch on pagehide (page refresh / tab close).
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      const html = editor.getHTML();
      const safe = DOMPurify.sanitize(html, SANITIZE_CONFIG);
      latestHtmlRef.current = safe;
      onChangeRef.current?.(safe);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  // Auto-save on unmount when the user is leaving the editor with unsaved
  // changes — e.g. closing the Todo tab, switching to another tab in the right
  // panel, or the React tree being torn down on refresh. Skipped when the
  // user explicitly hit Save or Cancel (those have already settled state).
  useEffect(() => {
    return () => {
      if (savedRef.current || cancelledRef.current) return;
      const latest = latestHtmlRef.current;
      if (!latest || latest === initialSeedRef.current) return;
      onSaveRef.current(latest);
    };
  }, []);

  // Keyboard shortcuts: Mod-s / Mod-Enter save, Escape cancel. Tiptap ships
  // its own keymap for bold/italic/etc; we add ours on top.
  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        handleSave();
        return;
      }
    };
    const el = editor.view.dom;
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [editor, handleSave, handleCancel]);

  return (
    <div
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
      <Toolbar editor={editor} onSave={handleSave} onCancel={handleCancel} t={t} />
      <div
        style={{
          flex: 1,
          minHeight: 120,
          overflow: "auto",
          background: "var(--bg-panel)",
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {editor && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor: e, from, to }) => {
            // Only show the bubble menu when the editor is editable and
            // there's a non-empty text selection. This matches the standard
            // Tiptap "format on selection" UX.
            if (!e.isEditable) return false;
            return from !== to;
          }}
        >
          <BubbleMenuColorContent editor={editor} />
        </BubbleMenu>
      )}
    </div>
  );
}

/**
 * Body of the bubble menu's text-color picker. Uses `useEditorState` so the
 * current color reflects the selection — when the user clicks a swatch and
 * `setColor` runs, the editor state changes and the picker re-renders with
 * the new color highlighted (or unhighlighted, when "No color" is picked).
 */
function BubbleMenuColorContent({ editor }: { editor: Editor }) {
  const currentColor = useEditorState({
    editor,
    selector: (snapshot) => {
      const attrs = snapshot.editor.getAttributes("textStyle");
      const c = attrs.color;
      return typeof c === "string" && c.length > 0 ? c : null;
    },
  });
  return (
    <TextColorPicker
      value={currentColor}
      onChange={(next) => applyEditorColor(editor, next)}
    />
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

type TFunction = (key: string) => string;

function Toolbar({
  editor,
  onSave,
  onCancel,
  t,
}: {
  editor: Editor | null;
  onSave: () => void;
  onCancel: () => void;
  t: TFunction;
}) {
  // Force a re-render when the editor's selection / active marks change, so
  // `isActive` highlighting on each button stays in sync.
  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => force((n) => n + 1);
    editor.on("selectionUpdate", onUpdate);
    editor.on("transaction", onUpdate);
    return () => {
      editor.off("selectionUpdate", onUpdate);
      editor.off("transaction", onUpdate);
    };
  }, [editor]);

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 4,
        padding: "4px 6px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-dim)",
        flexShrink: 0,
      }}
    >
      <ToolbarGroup>
        <ToolbarButton
          label={t("Bold")}
          active={!!editor?.isActive("bold")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          glyph={<b>B</b>}
        />
        <ToolbarButton
          label={t("Italic")}
          active={!!editor?.isActive("italic")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          glyph={<i>I</i>}
        />
        <ToolbarButton
          label={t("Strikethrough")}
          active={!!editor?.isActive("strike")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
          glyph={<s>S</s>}
        />
        <ToolbarButton
          label={t("Inline code")}
          active={!!editor?.isActive("code")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleCode().run()}
          glyph={<code style={{ fontSize: 10 }}>{"</>"}</code>}
        />
        {editor && (
          <TextColorToolbarButton
            editor={editor}
            active={editor.isActive("textStyle")}
          />
        )}
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton
          label={t("Heading 1")}
          active={!!editor?.isActive("heading", { level: 1 })}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
          glyph={<span style={{ fontWeight: 600 }}>H1</span>}
        />
        <ToolbarButton
          label={t("Heading 2")}
          active={!!editor?.isActive("heading", { level: 2 })}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          glyph={<span style={{ fontWeight: 600 }}>H2</span>}
        />
        <ToolbarButton
          label={t("Heading 3")}
          active={!!editor?.isActive("heading", { level: 3 })}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          glyph={<span style={{ fontWeight: 600 }}>H3</span>}
        />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton
          label={t("Bulleted list")}
          active={!!editor?.isActive("bulletList")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          glyph={<span>•&nbsp;≡</span>}
        />
        <ToolbarButton
          label={t("Numbered list")}
          active={!!editor?.isActive("orderedList")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          glyph={<span>1.&nbsp;≡</span>}
        />
        <ToolbarButton
          label={t("Task list")}
          active={!!editor?.isActive("taskList")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
          glyph={<span>☐&nbsp;≡</span>}
        />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton
          label={t("Quote")}
          active={!!editor?.isActive("blockquote")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          glyph={<span>{'" "'}</span>}
        />
        <ToolbarButton
          label={t("Code block")}
          active={!!editor?.isActive("codeBlock")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          glyph={<span>{"{ }"}</span>}
        />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton
          label={t("Insert link")}
          active={!!editor?.isActive("link")}
          disabled={!editor}
          onClick={() => {
            if (!editor) return;
            const prev = editor.getAttributes("link").href as string | undefined;
            const url = window.prompt(t("Insert link"), prev ?? "https://");
            if (url === null) return;
            if (url === "") {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              return;
            }
            editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
          }}
          glyph={<span>🔗</span>}
        />
        <ToolbarButton
          label={t("Insert image")}
          disabled={!editor}
          onClick={() => {
            if (!editor) return;
            const url = window.prompt(t("Insert image URL"), "https://");
            if (!url) return;
            editor.chain().focus().setImage({ src: url }).run();
          }}
          glyph={<span>🖼</span>}
        />
        <ToolbarButton
          label={t("Insert table")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          glyph={<span>⊞</span>}
        />
        <ToolbarButton
          label={t("Divider")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          glyph={<span>―</span>}
        />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton
          label={t("Undo")}
          disabled={!editor || !editor.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
          glyph={<span>↶</span>}
        />
        <ToolbarButton
          label={t("Redo")}
          disabled={!editor || !editor.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
          glyph={<span>↷</span>}
        />
        <ToolbarButton
          label={t("Clear formatting")}
          disabled={!editor}
          onClick={() => editor?.chain().focus().clearNodes().unsetAllMarks().run()}
          glyph={<span>Tx</span>}
        />
      </ToolbarGroup>
      <ToolbarGroup style={{ marginLeft: "auto", borderRight: "none" }}>
        <ToolbarButton label={t("Cancel")} glyph={<span>{t("Cancel")}</span>} onClick={onCancel} variant="ghost" />
        <ToolbarButton label={t("Save")} glyph={<span>{t("Save")}</span>} onClick={onSave} variant="primary" />
      </ToolbarGroup>
    </div>
  );
}

function ToolbarGroup({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        padding: "0 4px",
        borderRight: "1px solid var(--border)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
  glyph,
  variant = "ghost",
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  glyph: React.ReactNode;
  variant?: "ghost" | "primary";
}) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 22,
    height: 18,
    padding: "0 6px",
    fontSize: 11,
    lineHeight: 1,
    border: "1px solid var(--border)",
    borderRadius: 3,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    background: variant === "primary"
      ? "var(--accent)"
      : active
        ? "var(--bg-selected)"
        : "transparent",
    color: variant === "primary"
      ? "var(--bg)"
      : active
        ? "var(--text)"
        : disabled
          ? "var(--text-dim)"
          : "var(--text-muted)",
    opacity: disabled ? 0.5 : 1,
  };
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault() /* keep editor focus */}
      onClick={onClick}
      style={base}
    >
      {glyph}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Paste / drop helpers
// ---------------------------------------------------------------------------

async function uploadAndInsert(
  editor: Editor,
  files: File[],
  showToast: (input: { kind: "error"; message: string }) => void,
  t: TFunction,
  uploader: ImageUploader,
  coords?: { left: number; top: number },
): Promise<void> {
  if (files.length === 0) return;
  const { urls, errors } = await uploader(files);
  for (const err of errors) {
    showToast({ kind: "error", message: `${t("Failed to upload image")}: ${err}` });
  }
  if (urls.length === 0) return;
  // For drop events, place the images at the drop coordinates. For paste, just
  // append to the end of the document — Tiptap can't compute a paste target
  // from a synthetic event.
  if (coords) {
    try {
      const pos = editor.view.posAtCoords({ left: coords.left, top: coords.top });
      if (pos) {
        editor
          .chain()
          .focus()
          .insertContentAt(pos.pos, urls.map((src) => ({ type: "image", attrs: { src } })))
          .run();
        return;
      }
    } catch {
      // fall through to append
    }
  }
  editor
    .chain()
    .focus()
    .insertContent(urls.map((src) => ({ type: "image", attrs: { src } })))
    .run();
}
