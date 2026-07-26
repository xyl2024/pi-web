"use client";

import React, { useState, type ReactNode } from "react";

type Variant = "default" | "accent" | "danger";

interface IconHoverButtonProps {
  /** The icon (typically an <svg>) shown in the collapsed state. */
  icon: ReactNode;
  /** Plain text revealed when the button is hovered or focused. */
  label: string;
  onClick: () => void;
  /** Native tooltip fallback (also surfaced via title attr). Defaults to label. */
  title?: string;
  /** Accessible label for screen readers. Defaults to label. */
  ariaLabel?: string;
  /** Color variant — controls base/hover palette. */
  variant?: Variant;
  /** When true, the button stays expanded and uses the hover palette (e.g. dropdown open). */
  active?: boolean;
  /** When true, the button is grayed out and won't expand on hover/focus. */
  disabled?: boolean;
  /** Direction the label grows when expanded. "right" places the icon first then label (the usual
   *  left-to-right reading order); "left" places the label first so the button grows leftwards,
   *  useful for buttons anchored to the right edge of a toolbar. */
  expandDirection?: "left" | "right";
}

/**
 * A compact icon-only button that smoothly reveals a single word on hover/focus.
 *
 * Pattern lifted from TranslatePanel's top-bar buttons (Prompts / Copy / Clear). Below the
 * threshold it's a tight ~32px square; above it the label `span` fades in with its max-width
 * growing from 0 to 120px, while the flex gap animates from 0 to 4px — both over 0.15s.
 *
 * The component is stateful (one `useState` tracking hover) and wires `onFocus`/`onBlur` so
 * keyboard users get the same expansion via Tab. When `disabled` is true the four interaction
 * handlers short-circuit and the label never reveals — that's a deliberate choice over letting
 * disabled buttons hint at clickability.
 */
export function IconHoverButton({
  icon,
  label,
  onClick,
  title,
  ariaLabel,
  variant = "default",
  active = false,
  disabled = false,
  expandDirection = "right",
}: IconHoverButtonProps) {
  const [hovered, setHovered] = useState(false);
  const expanded = (hovered || active) && !disabled;

  const baseColor =
    variant === "accent" ? "var(--accent)" :
    variant === "danger" ? "#ef4444" :
    "var(--text-muted)";
  const hoverColor =
    variant === "accent" ? "var(--accent-hover)" :
    variant === "danger" ? "#ef4444" :
    "var(--text)";
  const baseBg = variant === "danger" ? "rgba(239,68,68,0.08)" : "none";
  const hoverBg = variant === "danger" ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";

  const color = disabled ? "var(--text-dim)" : (expanded ? hoverColor : baseColor);
  const bg = expanded ? hoverBg : baseBg;

  const labelStyle: React.CSSProperties = {
    opacity: expanded ? 1 : 0,
    maxWidth: expanded ? 120 : 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    transition: "opacity 0.15s, max-width 0.15s",
  };

  const buttonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: expanded ? 4 : 0,
    padding: "0 10px",
    height: 32,
    background: bg,
    border: "none",
    borderRadius: 9,
    color,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: "nowrap",
    transition: "background 0.12s, color 0.12s, gap 0.15s",
  };

  // When expandDirection is "left" the label sits to the left of the icon, so the button
  // grows leftward — useful for items anchored to the right edge of a toolbar.
  const labelNode = <span style={labelStyle}>{label}</span>;

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => { if (!disabled) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => { if (!disabled) setHovered(true); }}
      onBlur={() => setHovered(false)}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      title={title ?? label}
      style={buttonStyle}
    >
      {expandDirection === "left" ? <>{labelNode}{icon}</> : <>{icon}{labelNode}</>}
    </button>
  );
}
