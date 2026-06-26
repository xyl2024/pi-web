"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

interface Props {
  open: boolean;
  durationMs?: number;
  children: ReactNode;
  style?: CSSProperties;
}

// Wraps children in a height-animating container that smoothly expands
// downward and collapses upward. Uses the CSS grid 0fr/1fr trick, which
// is more reliable than max-height for variable-content panels and avoids
// the "ghost" extra space that max-height leaves behind.
export function CollapsiblePanel({ open, durationMs = 180, children, style }: Props) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Single rAF — the previous paint has already happened, so the closed
      // state is committed. One frame is enough to schedule the flip to open
      // and keeps the click → motion delay under one frame.
      const r = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(r);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(timer);
  }, [open, durationMs]);

  if (!mounted) return null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: visible ? "1fr" : "0fr",
        opacity: visible ? 1 : 0,
        // ease-out-quart: fast start so the click feels responsive, soft
        // landing so it doesn't snap-stop. Opacity is delayed and shorter
        // than the height so the content stays invisible while the panel is
        // small — this is what kills the "muddy" mid-animation look where
        // semi-transparent text sits squashed at near-zero height.
        transition: `grid-template-rows ${durationMs}ms cubic-bezier(0.32, 0.72, 0, 1), opacity ${Math.round(durationMs * 0.6)}ms ease ${Math.round(durationMs * 0.3)}ms`,
        ...style,
      }}
    >
      <div style={{ overflow: "hidden", minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}
