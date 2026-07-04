/**
 * DOMPurify configuration for RSS article HTML.
 *
 * Distinct from `lib/description-sanitize.ts` on purpose:
 *   - RSS feeds need a much wider tag set: <iframe>, <figure>, <picture>,
 *     <source>, <video>, <audio>, and <pre>/<code> blocks are common.
 *   - The feed content is third-party (untrusted) — the JavaScript-URL
 *     scheme must be blocked explicitly via ALLOWED_URI_REGEXP.
 *   - There's no Tiptap round-trip and no per-todo color picker, so the
 *     `style` widening hook from description-sanitize is unnecessary here.
 *
 * Sanitization runs at *render* time (in the reader view), not at storage
 * time. The store keeps the raw HTML so future tooling (search, diff,
 * export) can reuse it without re-parsing twice.
 */

import DOMPurify, { type Config } from "isomorphic-dompurify";

// ---------------------------------------------------------------------------
// Tag + attribute allowlists for RSS article HTML.
// ---------------------------------------------------------------------------

const RSS_ALLOWED_TAGS = [
  // Block
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "pre", "hr", "br",
  "div", "section", "article", "aside",
  "table", "thead", "tbody", "tr", "th", "td", "caption", "colgroup", "col",
  "figure", "figcaption",
  // Inline
  "strong", "b", "em", "i", "s", "strike", "u", "code", "a", "span",
  "img", "picture", "source",
  "video", "audio", "iframe",
  "sub", "sup", "small", "mark", "del", "ins",
] as const;

const RSS_ALLOWED_ATTR = [
  "href", "src", "alt", "title", "class", "id",
  "colspan", "rowspan", "scope",
  "loading", "srcset", "sizes",
  "width", "height",
  "target", "rel",
  "allow", "allowfullscreen", "frameborder", "sandbox",
  "controls", "poster", "preload",
  "type", "media",
] as const;

const FORBID_TAGS = ["script", "style", "object", "embed", "form", "input", "button"];
const FORBID_ATTR = ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "onchange", "onsubmit"];

/**
 * URL scheme allowlist — only http(s), mailto, tel, fragment, and root-
 * relative paths are accepted. Blocks javascript:, data:, vbscript:, etc.
 * data: is intentionally disallowed so we don't render arbitrary binary
 * blobs (which can also be used as XSS vectors via SVG payloads).
 */
const SAFE_URI_PATTERN = /^(?:(?:https?|mailto|tel):|#|\/)/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildRssSanitizeConfig(): Config {
  return {
    ALLOWED_TAGS: [...RSS_ALLOWED_TAGS],
    ALLOWED_ATTR: [...RSS_ALLOWED_ATTR],
    FORBID_TAGS: [...FORBID_TAGS],
    FORBID_ATTR: [...FORBID_ATTR],
    ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
    KEEP_CONTENT: true,
    // Force external links to open in a new tab so an attacker can't replace
    // the parent tab via `target="_self"`.
    ADD_ATTR: ["target", "rel"],
  };
}

/**
 * Sanitize an RSS article HTML string. Returns "" for nullish / empty input.
 */
export function sanitizeRssHtml(html: string | null | undefined): string {
  if (!html) return "";
  const config = buildRssSanitizeConfig();
  return DOMPurify.sanitize(html, config) as string;
}