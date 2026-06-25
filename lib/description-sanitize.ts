/**
 * Shared DOMPurify configuration for todo description HTML.
 *
 * Single source of truth for the allowlist used by every code path that
 * touches a todo description:
 *
 *   - server-side storage (`lib/todo-store.ts` normalizeDescription)
 *   - rich-text editor save/mount (`components/RichTextEditorInner.tsx`)
 *   - read-only view render (`components/TodoDescriptionView.tsx`)
 *   - legacy markdown → HTML migration (`hooks/useTodos.tsx`)
 *   - zip export — uses `allowStyle: false` to drop color spans on .md
 *
 * The default allowlist mirrors the historical one in `lib/todo-store.ts`;
 * `allowStyle: true` widens `ALLOWED_ATTR` to include `style`, and registers
 * a single `uponSanitizeAttribute` hook (idempotent across module loads)
 * that rewrites every style value to only `color: #rrggbb`. Anything else
 * inside `style` — background, font-size, position, url(...), expression(),
 * javascript: — is stripped. The hook is what makes widening the allowlist
 * safe; without it, opening `style` would be a CSS-injection vector.
 */

import DOMPurify, { type Config } from "isomorphic-dompurify";

// ---------------------------------------------------------------------------
// Tag + attribute allowlists — match the original constants in
// lib/todo-store.ts (DESCRIPTION_ALLOWED_TAGS / DESCRIPTION_ALLOWED_ATTR).
// Anything emitted by Tiptap and the legacy markdown migration must land in
// one of these two lists.
// ---------------------------------------------------------------------------

const DESCRIPTION_ALLOWED_TAGS = [
  // Block
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "pre", "hr", "br", "div",
  "table", "thead", "tbody", "tr", "th", "td",
  // Inline
  "strong", "b", "em", "i", "s", "strike", "u", "code", "a", "span", "img", "sub", "sup",
  // Form (Tiptap's TaskList renders <input type="checkbox" disabled>)
  "input",
  "label",
] as const;

const DESCRIPTION_ALLOWED_ATTR = [
  "href", "src", "alt", "title", "class",
  "colspan", "rowspan",
  "type", "checked", "disabled", "value",
  "target", "rel",
  "data-type", "data-checked",
  "start",
] as const;

// Hex colors only — canonical form for storage. The picker is <input
// type="color">, which always emits #rrggbb, so hex is what we round-trip.
// The browser, however, normalizes any inline style value to `rgb(r, g, b)`
// when read back through `element.style.color`. Tiptap does exactly that
// when it parses a saved `<span style="color: #ff0000">` and then re-emits
// the document — the next save would carry `color: rgb(255, 0, 0)`, which
// this hook used to silently strip. Accept rgb()/rgba() here too and
// normalize back to lowercase hex so the stored HTML stays in one shape.
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const RGB_COLOR_PATTERN = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/;

/**
 * Normalize a CSS color value to lowercase `#rrggbb`. Returns null for any
 * non-RGB color (named, hsl, currentcolor, …) so the hook can drop it.
 */
function normalizeColor(value: string): string | null {
  if (HEX_COLOR_PATTERN.test(value)) return value.toLowerCase();
  const m = RGB_COLOR_PATTERN.exec(value);
  if (!m) return null;
  // Alpha is dropped: the picker has no alpha channel, and the editor only
  // round-trips RGB-equivalent colors.
  const hex =
    "#" +
    [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("");
  return hex;
}

/**
 * Parse a CSS declaration block (e.g. `"color: red; background: blue;"`)
 * and return only the surviving `color: #rrggbb` declaration, lowercased.
 * Returns an empty string if no valid color survives.
 */
function extractColorFromStyle(styleValue: string): string {
  let color: string | null = null;
  for (const decl of styleValue.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const key = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (key === "color") {
      const normalized = normalizeColor(value);
      if (normalized) color = normalized;
    }
  }
  return color ? `color: ${color}; ` : "";
}

// ---------------------------------------------------------------------------
// Hook — installed once at module load. Fires for every sanitize() call but
// only acts when the active config has `style` in ALLOWED_ATTR (verified via
// hookEvent.allowedAttributes.style). When `style` is not allowed, the hook
// is a no-op because the attribute has already been removed before the hook
// runs.
//
// DOMPurify writes the original style value into the DOM node before calling
// the hook, so the only way to rewrite it is via `node.setAttribute(...)`.
// Mutating `hookEvent.attrValue` is silently ignored — the attribute value
// is read from the live DOM, not from the hook event.
// ---------------------------------------------------------------------------

let installed = false;

function installHook(): void {
  if (installed) return;
  installed = true;
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "style") return;
    // `data.allowedAttributes` is keyed by attribute name. When `style` is
    // not in this config's allowlist, DOMPurify already dropped the
    // attribute — no work to do here.
    if (!data.allowedAttributes.style) return;
    const original = data.attrValue ?? "";
    const cleaned = extractColorFromStyle(original);
    if (cleaned) {
      (_node as Element).setAttribute("style", cleaned);
      data.keepAttr = true;
    } else {
      data.keepAttr = false;
    }
  });
}

installHook();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DescriptionSanitizeOptions {
  /**
   * When true, `style` is added to ALLOWED_ATTR and the hook above is
   * active (rewriting `style` to only `color: #rrggbb`). Default: false —
   * any `style` attribute is stripped entirely. The export route uses
   * `false` so the exported `.md` loses every color span; the editor
   * save/mount, the read view, and the storage path all use `true`.
   */
  allowStyle?: boolean;
}

/**
 * Build a DOMPurify config for a todo description. Callers pass the result
 * as the second argument to `DOMPurify.sanitize(html, config)`.
 */
export function buildDescriptionSanitizeConfig(
  opts: DescriptionSanitizeOptions = {},
): Config {
  const allowStyle = opts.allowStyle ?? false;
  const allowedAttr = allowStyle
    ? [...DESCRIPTION_ALLOWED_ATTR, "style"]
    : [...DESCRIPTION_ALLOWED_ATTR];
  return {
    ALLOWED_TAGS: [...DESCRIPTION_ALLOWED_TAGS],
    ALLOWED_ATTR: allowedAttr,
    // Note: ALLOW_DATA_ATTR is intentionally left at its default (true) so
    // the explicit `data-type` / `data-checked` entries in
    // DESCRIPTION_ALLOWED_ATTR actually take effect — DOMPurify treats
    // data-* attributes specially and ALLOW_DATA_ATTR: false would override
    // the explicit allowlist.
    KEEP_CONTENT: true,
  };
}
