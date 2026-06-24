"use client";

/**
 * TextColorPicker — editor-scoped color picker for Tiptap descriptions.
 *
 * Two pieces:
 *   - <TextColorPicker />: the bare swatch grid + custom cell + "No color"
 *     footer. No positioning or click-outside — those are owned by whatever
 *     surface hosts it (toolbar popover or Tiptap BubbleMenu).
 *   - <ColorPickerPopover />: a small wrapper that adds the popover chrome
 *     (positioning, click-outside, Escape) used by the toolbar button.
 *
 * Mirrors the existing TagColorPicker in components/TodoPanel.tsx:1881-1988
 * but is editor-scoped — every interactive element calls preventDefault on
 * mousedown so the editor retains its selection while the user clicks a
 * swatch. The 8 presets are shared via lib/todo-color-presets.ts so tag
 * chips and description text color use the exact same palette.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
// Side-effect import — the extension itself is registered by RichTextEditorInner,
// but its `.d.ts` carries the `Commands<…>` augmentation that gives `setColor`
// / `unsetColor` their types. Without this import, TS doesn't see the
// augmentation and ChainedCommands rejects the calls below.
import "@tiptap/extension-color";
import { TAG_COLOR_PRESETS } from "@/lib/todo-color-presets";
import { useI18n } from "@/hooks/useI18n";

// ---------------------------------------------------------------------------
// Color application — wraps the Tiptap commands so the caller doesn't have to
// branch on null. `setColor` / `unsetColor` both preserve the current
// selection, so the toolbar button or BubbleMenu stays open after a click
// and the user can correct the pick without re-selecting.
// ---------------------------------------------------------------------------

export function applyEditorColor(editor: Editor, color: string | null): void {
  if (color === null) {
    editor.chain().focus().unsetColor().run();
  } else {
    editor.chain().focus().setColor(color).run();
  }
}

/** Read the color of the selection's start. Returns null when no color is set. */
export function readEditorColor(editor: Editor): string | null {
  // textStyle is the mark Color writes into; checking the mark at the start
  // of the selection gives a representative "current color" for the button
  // glyph. A mixed-color selection simply returns null (button shows neutral).
  const attrs = editor.getAttributes("textStyle");
  const c = attrs.color;
  return typeof c === "string" && c.length > 0 ? c : null;
}

// ---------------------------------------------------------------------------
// TextColorPicker — the inner swatch grid. Used by the toolbar popover and
// by the Tiptap BubbleMenu body.
// ---------------------------------------------------------------------------

export function TextColorPicker({
  value,
  onChange,
}: {
  /** Current color at the editor's selection. `null` = no color / mixed. */
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="dialog"
      aria-label={t("Text color")}
      onMouseDown={(e) => {
        // Stop the toolbar popover's outside-click from dismissing itself
        // when the user mouses down on the picker body (clicks on swatches
        // also preventDefault to keep editor focus — see below).
        e.stopPropagation();
      }}
      style={{
        padding: 6,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          padding: "0 2px 4px",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {t("Text color")}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 4,
        }}
      >
        {TAG_COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onClick={() => onChange(c)}
            onMouseDown={(e) => e.preventDefault()}
            style={{
              width: 18,
              height: 18,
              padding: 0,
              border:
                value === c ? "2px solid var(--accent)" : "1px solid var(--border)",
              borderRadius: 3,
              background: c,
              cursor: "pointer",
            }}
          />
        ))}
        <label
          aria-label={t("Custom color")}
          title={t("Custom color")}
          style={{
            width: 18,
            height: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px dashed var(--border)",
            borderRadius: 3,
            cursor: "pointer",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <input
            type="color"
            value={value ?? "#000000"}
            onChange={(e) => onChange(e.target.value)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: "none",
              padding: 0,
              background: "transparent",
              cursor: "pointer",
              opacity: 0,
            }}
          />
          <span
            aria-hidden
            style={{
              color: "var(--text-dim)",
              fontSize: 10,
              lineHeight: 1,
              pointerEvents: "none",
            }}
          >
            ⋯
          </span>
        </label>
      </div>
      <button
        type="button"
        onClick={() => onChange(null)}
        onMouseDown={(e) => e.preventDefault()}
        disabled={value === null}
        style={{
          marginTop: 6,
          width: "100%",
          padding: "3px 6px",
          fontSize: 10,
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 3,
          color: value === null ? "var(--text-dim)" : "var(--text-muted)",
          cursor: value === null ? "default" : "pointer",
          fontFamily: "inherit",
        }}
      >
        {t("No color")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ColorPickerPopover — wrapper used by the toolbar button. Adds click-outside
// + Escape handling. Positioning is owned by the button's parent (a
// `position: relative` div with the popover at `top: 100%; left: 0`).
// ---------------------------------------------------------------------------

export function ColorPickerPopover({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        top: "calc(100% + 2px)",
        left: 0,
        zIndex: 20,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TextColorToolbarButton — the toolbar entry point. Renders the "A with a
// colored underline" glyph; click toggles the ColorPickerPopover. The
// colored bar reflects the current selection's color (or the accent theme
// color when no color is active) so the user can see what's active at a
// glance. The button's `active` state mirrors `editor.isActive("textStyle")`
// via the existing toolbar force-update hook in RichTextEditorInner.
// ---------------------------------------------------------------------------

export function TextColorToolbarButton({
  editor,
  active,
}: {
  editor: Editor;
  active: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const currentColor = readEditorColor(editor);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        aria-label={t("Text color")}
        title={t("Text color")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
          minWidth: 22,
          height: 22,
          padding: "0 4px",
          fontSize: 11,
          lineHeight: 1,
          border: "1px solid var(--border)",
          borderRadius: 3,
          cursor: "pointer",
          fontFamily: "inherit",
          background: active ? "var(--bg-selected)" : "transparent",
          color: active ? "var(--text)" : "var(--text-muted)",
        }}
      >
        <span style={{ fontWeight: 600 }}>A</span>
        <span
          aria-hidden
          style={{
            display: "block",
            width: 12,
            height: 2,
            borderRadius: 1,
            background: currentColor ?? "var(--accent)",
          }}
        />
      </button>
      {open && (
        <ColorPickerPopover onClose={() => setOpen(false)}>
          <TextColorPicker
            value={currentColor}
            onChange={(next) => {
              applyEditorColor(editor, next);
              // Leave the popover open so the user can re-pick without
              // re-clicking the toolbar button — Tiptap's setColor preserves
              // the selection so subsequent picks still apply to the same
              // range. Escape / outside-click is the explicit close path.
            }}
          />
        </ColorPickerPopover>
      )}
    </div>
  );
}
