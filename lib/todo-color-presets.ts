/**
 * Shared color palette + contrast helper for todo affordances.
 *
 * Single source of truth used by both the tag color picker (chip background)
 * and the description text color picker (character color). Originally
 * inlined inside components/TodoPanel.tsx alongside the tag manager; lifted
 * here so the new TextColorPicker in the rich-text description editor can
 * share the exact same palette and the user only learns one set of colors.
 */

/**
 * 8 carefully-chosen preset colors. Red/Orange/Yellow/Green/Teal/Blue/Purple/Pink —
 * covers the common "Trello / Linear / GitHub" labels palette without overwhelming
 * the picker. The 9th slot in each UI hosts the native color picker for anything
 * custom; the constant itself stays at 8.
 */
export const TAG_COLOR_PRESETS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ec4899", // pink
] as const;

/**
 * Pick white or near-black so tag text stays legible on the saturated
 * background. sRGB luminance (BT.601) is enough for the preset palette and
 * any reasonable custom color — the 0.6 threshold keeps yellow readable.
 *
 * Used by the tag chip rendering; the description text color picker does not
 * need this (the chosen color *is* the foreground), but it's exported here
 * for symmetry and in case any future affordance (e.g. tag chip in the
 * description) needs it.
 */
export function tagContrastText(hex: string): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return "#1a1a1a";
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1a1a1a" : "#ffffff";
}
