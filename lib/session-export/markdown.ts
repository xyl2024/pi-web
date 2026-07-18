// Server-side markdown → HTML via `marked` (already a project dep).
//
// marked v18 inline-escapes raw HTML tags (so LLM-emitted `<script>` inside text
// becomes literal characters), and the rendered HTML is wrapped in our own
// `<div class="markdown-body">` element — which the export's injected CSS
// styles. Block-level raw HTML is rare in pi agent output; if it appears, it
// lands inside a `<pre><code>` block and is rendered as literal text by the
// browser, never executed. This is intentional — we explicitly do not want
// the export HTML to interpret arbitrary HTML from the conversation.

import { marked } from "marked";

export function renderMarkdown(input: string): string {
  if (!input) return "";
  const html = marked.parse(input, {
    gfm: true,
    breaks: true,
    async: false,
  }) as string;
  return html;
}
