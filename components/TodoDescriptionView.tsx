"use client";

import { useMemo, type CSSProperties, type JSX, type ReactNode } from "react";
import DOMPurify from "isomorphic-dompurify";
import parse, { domToReact, type DOMNode, type Element, type HTMLReactParserOptions } from "html-react-parser";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownImage } from "./ImageLightbox";
import { MermaidBlock } from "./MermaidBlock";
import { highlightDeep } from "./HighlightText";

interface Props {
  /** Sanitized HTML produced by the Tiptap editor (or DOMPurify output). */
  html: string;
  /** Search term to highlight across the rendered text. Empty disables highlight. */
  searchTerm?: string;
  /** Called when a todo description image is clicked. */
  onImageClick?: (src: string) => void;
  className?: string;
  style?: CSSProperties;
  /** Empty-state placeholder when `html` is empty / blank. */
  emptyPlaceholder?: string;
}

// Sanitize config — kept narrow on purpose. The server-side allowlist in
// lib/todo-store.ts is the source of truth; this is a defense-in-depth
// pass on the client in case untrusted content slips through.
const SANITIZE_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ALLOWED_TAGS: [
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "blockquote", "pre", "hr", "br", "div",
    "table", "thead", "tbody", "tr", "th", "td",
    "strong", "b", "em", "i", "s", "strike", "u", "code", "a", "span", "img", "sub", "sup",
    "input", "label",
  ],
  ALLOWED_ATTR: [
    "href", "src", "alt", "title", "class",
    "colspan", "rowspan",
    "type", "checked", "disabled", "value",
    "target", "rel",
    "data-type", "data-checked",
    "start",
  ],
};

/**
 * Read-only render of a todo description (Tiptap-emitted HTML). The container
 * carries the `markdown-body` class so every rule in `app/globals.css` under
 * `.markdown-body` (headings, lists, blockquote, table, hr, img, …) lights up
 * automatically — no per-theme overrides needed.
 *
 * The HTML is sanitized client-side, then walked via html-react-parser with
 * custom replacements for the few nodes that need special handling:
 *   - `<img>`            → MarkdownImage (zoom-in cursor, lightbox click)
 *   - `<pre><code class="language-mermaid">` → MermaidBlock
 *   - `<ul data-type="taskList">` / `<li data-type="taskItem">` → styled
 *     checkbox list (see .todo-task-list / .todo-task-item in globals.css)
 *   - `<a>`              → force target=_blank + rel=noopener noreferrer
 *
 * The search-term highlight pass walks the parsed React tree via
 * `highlightDeep` (see components/HighlightText.tsx), wrapping every
 * matching text leaf in a `<mark>`.
 */
export function TodoDescriptionView({
  html,
  searchTerm = "",
  onImageClick,
  className,
  style,
  emptyPlaceholder,
}: Props) {
  const { t } = useI18n();

  // Sanitize once per html change. The cost is non-trivial on large docs, so
  // memoize on the input string.
  const sanitized = useMemo(() => {
    if (!html) return "";
    try {
      return DOMPurify.sanitize(html, SANITIZE_CONFIG);
    } catch {
      return "";
    }
  }, [html]);

  const options = useMemo<HTMLReactParserOptions>(() => {
    const replace = (node: DOMNode): JSX.Element | string | null | boolean | object | void => {
      if (node.type !== "tag") return undefined;

      const el = node as Element;

      // <pre><code class="language-mermaid">…</code></pre> → MermaidBlock
      if (el.name === "pre") {
        const codeChild = el.children?.find(
          (c): c is Element => c.type === "tag" && (c as Element).name === "code",
        );
        if (codeChild) {
          const cls = (codeChild.attribs?.class ?? "") as string;
          const langMatch = /language-(\S+)/.exec(cls);
          if (langMatch && langMatch[1] === "mermaid") {
            const text = stringifyChildren(codeChild.children as DOMNode[]);
            return (
              <MermaidBlock
                key={`mermaid-${text}`}
                code={String(text ?? "").replace(/\n$/, "")}
              />
            );
          }
        }
      }

      // <img> → MarkdownImage (with lightbox click hook)
      if (el.name === "img") {
        const src = el.attribs?.src ?? "";
        if (!src) return null;
        return (
          <MarkdownImage
            src={src}
            alt={el.attribs?.alt ?? ""}
            resolveSrc={(s) => s}
            onImageClick={onImageClick}
            maxWidth="200px"
          />
        );
      }

      // <a> → force new-tab + noopener. The HTMLAttributes on Tiptap's Link
      // extension should already emit these, but we re-assert here for content
      // that came in from outside the editor (agent tool, copy-paste).
      if (el.name === "a") {
        return (
          <a
            href={el.attribs?.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {domToReact(el.children as DOMNode[], { trim: true })}
          </a>
        );
      }

      // <ul data-type="taskList"> → attach our class for CSS hit
      if (el.name === "ul" && (el.attribs?.["data-type"] === "taskList" || el.attribs?.class?.includes("todo-task-list"))) {
        return (
          <ul data-type="taskList" className="todo-task-list">
            {domToReact(el.children as DOMNode[])}
          </ul>
        );
      }

      // <li data-type="taskItem"> → flatten the Tiptap <label> wrapper and
      // render our own checkbox + content. Tiptap wraps the checkbox in a
      // <label> that contains an <input type="checkbox"> + the list item
      // text. We render the checkbox ourselves so it lines up with the text
      // and ignore the wrapping <label>.
      if (el.name === "li" && (el.attribs?.["data-type"] === "taskItem" || el.attribs?.class?.includes("todo-task-item"))) {
        const checked = el.attribs?.["data-checked"] === "true" || hasCheckedInput(el);
        return (
          <li data-type="taskItem" data-checked={String(checked)} className="todo-task-item">
            <input type="checkbox" checked={checked} disabled readOnly />
            <div style={{ flex: 1, minWidth: 0 }}>
              {domToReact(el.children as DOMNode[])}
            </div>
          </li>
        );
      }

      return undefined;
    };

    return { replace };
  }, [onImageClick]);

  const rendered = useMemo(() => {
    if (!sanitized) return null;
    return parse(sanitized, options);
  }, [sanitized, options]);

  if (!sanitized.trim()) {
    return (
      <div
        className={className}
        style={{
          fontSize: 12,
          color: "var(--text-dim)",
          fontStyle: "italic",
          padding: "2px 0",
          ...style,
        }}
      >
        {emptyPlaceholder ?? t("Add description...")}
      </div>
    );
  }

  const highlighted = searchTerm
    ? (highlightDeep(rendered, searchTerm) as ReactNode)
    : rendered;

  return (
    <div
      className={`markdown-body ${className ?? ""}`.trim()}
      style={{ fontSize: 12, ...style }}
    >
      {highlighted}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenate all text inside a list of DOM nodes. Used to extract the raw
 * Mermaid source from `<pre><code>` children. */
function stringifyChildren(children: DOMNode[] | undefined): string {
  if (!children) return "";
  let out = "";
  for (const c of children) {
    if (c.type === "text") out += String((c as { data: unknown }).data ?? "");
    else if (c.type === "tag") out += stringifyChildren((c as Element).children as DOMNode[]);
  }
  return out;
}

function hasCheckedInput(li: Element): boolean {
  const stack: Element[] = [li];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.name === "input" && (cur.attribs?.type === "checkbox" || cur.attribs?.checked !== undefined)) {
      return cur.attribs?.checked !== undefined;
    }
    for (const child of (cur.children ?? []) as DOMNode[]) {
      if (child.type === "tag") stack.push(child as Element);
    }
  }
  return false;
}
