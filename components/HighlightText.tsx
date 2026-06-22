"use client";

import { Fragment, cloneElement, createElement, isValidElement, type ReactNode } from "react";

/**
 * Wrap every occurrence of `term` in `text` with a `<mark>` for the search
 * highlight pass. Case-insensitive. Returns the original text unchanged when
 * `term` is empty so the read-only description view is a no-op when no
 * search is active.
 */
export function highlightMatch(text: string, term: string): ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(t, i);
    if (idx === -1) break;
    ranges.push([idx, idx + t.length]);
    i = idx + t.length;
  }
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([s, e], k) => {
    if (s > cursor) out.push(text.slice(cursor, s));
    out.push(
      <mark
        key={k}
        style={{ background: "#fde047", color: "#1a1a1a", borderRadius: 2, padding: "0 1px" }}
      >
        {text.slice(s, e)}
      </mark>,
    );
    cursor = e;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/**
 * Recursively walk a React node tree and apply `highlightMatch` to every text
 * leaf. Used to inject the search-term `<mark>` wrapping into nested
 * component trees produced by react-markdown / html-react-parser.
 */
export function highlightDeep(node: ReactNode, term: string): ReactNode {
  if (!term) return node;
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "number") return highlightMatch(String(node), term);
  if (typeof node === "string") return highlightMatch(node, term);
  if (Array.isArray(node)) {
    return node.map((child, i) => <Fragment key={i}>{highlightDeep(child, term)}</Fragment>);
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const element = node;
    return cloneElement(element, { children: highlightDeep(element.props.children, term) });
  }
  return node;
}

// Re-export createElement to keep the legacy import surface stable for
// callers that previously did `import { createElement } from "react"` next
// to highlightDeep — avoiding a now-unused import warning in old code.
export { createElement };
