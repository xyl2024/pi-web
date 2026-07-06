"use client";

/**
 * Suggestion list for the in-progress `#<category>` token inside a Finance
 * details input. Renders into `document.body` via a portal so it escapes
 * any parent that might clip floating UI (the right-side panel stack in
 * AppShell commonly sets `overflow: hidden`). The popover anchors itself to
 * the input element via `getBoundingClientRect()` and tracks scroll/resize
 * so it stays glued to the right edge of the field even when the page moves.
 *
 * The list is preset-only — there is no "Create new" row because the
 * Finance feature no longer allows user-defined categories.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

export interface FinanceCategoryPopoverItem {
  name: string;
  count: number;
}

interface FinanceCategoryPopoverProps {
  /** The input element the popover is anchored to (textarea or input). */
  anchorRef: RefObject<HTMLElement | null>;
  items: FinanceCategoryPopoverItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  /** Click outside / Escape — parent toggles the open state. */
  onDismiss: () => void;
}

interface PopoverPos {
  top: number;
  left: number;
  width: number;
  /** Final height in px — may be less than `POPOVER_MAX_HEIGHT` when the
   *  available space (above or below the input) is constrained by the
   *  viewport. */
  height: number;
}

const POPOVER_MAX_HEIGHT = 240;
const POPOVER_GAP = 4;

export function FinanceCategoryPopover({
  anchorRef,
  items,
  activeIndex,
  onHover,
  onSelect,
  onDismiss,
}: FinanceCategoryPopoverProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  // Recompute position from the anchor's rect. Runs when the popover mounts
  // and on every relevant scroll/resize. We use capture-phase scroll so
  // scroll events fired by ANY ancestor (including non-bubbling cases) still
  // reach us.
  useEffect(() => {
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Flip above the input when there isn't enough room below — the
      // `FinanceQuickEntry` strip is sticky at the bottom of the right panel
      // and has no usable space below it. Standard dropdown behavior.
      const spaceBelow = window.innerHeight - rect.bottom - POPOVER_GAP;
      const spaceAbove = rect.top - POPOVER_GAP;
      const placeAbove =
        spaceBelow < POPOVER_MAX_HEIGHT && spaceAbove > spaceBelow;
      const height = placeAbove
        ? Math.min(POPOVER_MAX_HEIGHT, spaceAbove)
        : Math.min(POPOVER_MAX_HEIGHT, spaceBelow);
      const top = placeAbove
        ? rect.top - POPOVER_GAP - height
        : rect.bottom + POPOVER_GAP;
      setPos({ top, left: rect.left, width: rect.width, height });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorRef]);

  // Dismiss on any mousedown that lands outside the popover AND outside the
  // anchored input. We can't use `onBlur` because the popover lives in a
  // different part of the DOM tree.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current && ref.current.contains(target)) return;
      if (anchorRef.current && anchorRef.current.contains(target)) return;
      onDismiss();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [anchorRef, onDismiss]);

  // Escape-to-dismiss fallback. The parent input also handles Escape but
  // only when its own keydown fires; this catches edge cases where the focus
  // has moved to the popover (e.g. after a mouse click on a row).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={ref}
      role="listbox"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: 10001, // above the modal (10000)
        height: pos.height,
        maxHeight: POPOVER_MAX_HEIGHT,
        overflowY: "auto",
        padding: 4,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
      }}
    >
      {items.length === 0 ? (
        <div
          style={{
            padding: "6px 10px",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          {t("No matching categories")}
        </div>
      ) : (
        items.map((item, i) => {
          const isActive = i === activeIndex;
          return (
            <div
              key={item.name}
              role="option"
              aria-selected={isActive}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // mousedown (not click) so the input's blur doesn't dismiss
                // the popover before our handler runs.
                e.preventDefault();
                onSelect(i);
              }}
              style={{
                padding: "6px 10px",
                fontSize: 13,
                cursor: "pointer",
                background: isActive ? "var(--bg-selected)" : "transparent",
                color: "var(--text)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                borderRadius: 3,
              }}
            >
              <span style={{ color: "var(--text-dim)" }}>#</span>
              <span style={{ flex: 1 }}>{item.name}</span>
              {item.count > 0 && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  {item.count}
                </span>
              )}
            </div>
          );
        })
      )}
    </div>,
    document.body,
  );
}

/**
 * Detect an in-progress `#xxx` token at the cursor in a free-text input.
 * Returns null when the cursor isn't inside a category trigger (e.g. cursor
 * sits after a space, or no `#` has been typed yet). Mirrors TodoPanel's
 * `detectActiveTagToken` so the two `#`-pickers feel identical.
 */
export function detectActiveCategoryToken(
  value: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  if (cursor < 1) return null;
  const upTo = value.slice(0, cursor);
  const hashIdx = upTo.lastIndexOf("#", cursor - 1);
  if (hashIdx < 0) return null;
  // Must be at start of input or preceded by whitespace.
  if (hashIdx > 0 && !/\s/.test(value.charAt(hashIdx - 1))) return null;
  const after = value.slice(hashIdx + 1, cursor);
  if (/\s/.test(after)) return null;
  return { start: hashIdx, end: cursor, query: after };
}
