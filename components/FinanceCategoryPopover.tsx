"use client";

/**
 * Suggestion list for the in-progress `#<category>` token inside a Finance
 * details input. Lists preset categories whose names contain the current
 * query, with keyboard and mouse nav owned by the parent (so the input
 * keeps focus and cursor-placement authority). Mirrors TodoPanel's
 * TagPickerPopover in shape, but categories are preset-only — there is no
 * "Create new" row.
 */

import { useEffect, useRef } from "react";

export interface FinanceCategoryPopoverItem {
  name: string;
  count: number;
}

interface FinanceCategoryPopoverProps {
  items: FinanceCategoryPopoverItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  onMouseDownOutside: () => void;
}

export function FinanceCategoryPopover({
  items,
  activeIndex,
  onHover,
  onSelect,
  onMouseDownOutside,
}: FinanceCategoryPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onMouseDownOutside();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onMouseDownOutside]);

  return (
    <div
      ref={ref}
      role="listbox"
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        zIndex: 10,
        maxHeight: 200,
        overflowY: "auto",
        padding: 4,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
      }}
    >
      {items.map((item, i) => {
        const isActive = i === activeIndex;
        return (
          <div
            key={item.name}
            role="option"
            aria-selected={isActive}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              // mousedown (not click) so the input's blur doesn't dismiss the
              // popover before our handler runs.
              e.preventDefault();
              onSelect(i);
            }}
            style={{
              padding: "4px 8px",
              fontSize: 12,
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
      })}
    </div>
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
