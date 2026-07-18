// Inline CSS for the single-file HTML export.
//
// Hardcoded light theme (matches `.theme-default` from app/globals.css:22-42) and
// the rendering styles needed for messages: bubbles, markdown-body output,
// thinking/toolCall/attachment blocks. Receivers do NOT need to load any external
// stylesheet — opening the .html in any browser just works.

export const EXPORT_CSS = `
:root {
  /* fonts (mirrors :root in app/globals.css:185-188) */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "Consolas", "JetBrains Mono", "Fira Code", ui-monospace,
               "PingFang SC", "Microsoft YaHei", monospace;

  /* light theme tokens (hardcoded; mirrors .theme-default in app/globals.css:22-42) */
  --bg: #ffffff;
  --bg-panel: #fcfcfc;
  --bg-hover: #f7f7f7;
  --bg-selected: #f3f3f3;
  --border: #ededed;
  --text: #1a1a1a;
  --text-muted: #6b7280;
  --text-dim: #9ca3af;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --user-bg: #eff6ff;
  --assistant-bg: #ffffff;
  --tool-bg: #fefefe;
  --bg-subtle: rgba(0,0,0,0.03);

  --font-size: 14px;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: var(--font-size);
  line-height: 1.6;
}
body { padding: 24px 16px 64px; }

a { color: var(--accent); text-decoration: underline; }
a:hover { color: var(--accent-hover); }

pre, code { font-family: var(--font-mono); }

/* ── Header ────────────────────────────────────────────── */
.export-header {
  max-width: 880px;
  margin: 0 auto 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.export-header h1 {
  font-size: 22px;
  margin: 0 0 6px;
  color: var(--text);
  word-break: break-word;
}
.export-header .export-meta {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}

/* ── Message container ─────────────────────────────────── */
.messages {
  max-width: 880px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.msg {
  border-radius: 12px;
  padding: 12px 16px;
  max-width: 88%;
  word-break: break-word;
}
.msg-user {
  margin-left: auto;
  background: var(--user-bg);
  border: 1px solid rgba(37,99,235,0.18);
}
.msg-assistant {
  margin-right: auto;
  background: var(--assistant-bg);
  border: 1px solid var(--border);
}
.msg-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.msg-role { font-weight: 600; color: var(--text-muted); }
.msg-body > *:first-child { margin-top: 0; }
.msg-body > *:last-child { margin-bottom: 0; }

/* ── markdown-body (mirrors app/globals.css:195-247) ──── */
.markdown-body {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text);
  word-break: break-word;
}
.markdown-body p { margin: 0 0 8px; }
.markdown-body p:last-child { margin-bottom: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  font-weight: 600;
  margin: 10px 0 4px;
  color: var(--text);
}
.markdown-body h1 { font-size: 1.15em; }
.markdown-body h2 { font-size: 1.05em; }
.markdown-body h3 { font-size: 0.95em; }
.markdown-body ul, .markdown-body ol { padding-left: 20px; margin: 4px 0 8px; }
.markdown-body ul { list-style: disc; }
.markdown-body ol { list-style: decimal; }
.markdown-body li { margin: 2px 0; }
.markdown-body blockquote {
  border-left: 3px solid var(--border);
  margin: 4px 0;
  padding: 2px 10px;
  color: var(--text-muted);
}
.markdown-body code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-panel);
  padding: 1px 5px;
  border-radius: 3px;
}
.markdown-body pre {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  margin: 10px 0;
}
.markdown-body pre code { background: none; padding: 0; font-size: inherit; }
.markdown-body img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 4px 0;
}
.markdown-body a { color: var(--accent); text-decoration: underline; }
.markdown-body hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 12px 0;
}
.markdown-body table {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
  font-size: 13px;
}
.markdown-body th, .markdown-body td {
  border: 1px solid var(--border);
  padding: 5px 10px;
  text-align: left;
}
.markdown-body th { background: var(--bg-panel); font-weight: 600; }

/* ── User-image attachment (uploaded inline) ───────────── */
.msg-user .msg-images {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.msg-user .msg-images img {
  max-width: 100%;
  max-height: 320px;
  border-radius: 6px;
  border: 1px solid var(--border);
}

/* ── Thinking block (collapsed by default) ────────────── */
details.thinking {
  margin: 8px 0 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
}
details.thinking > summary {
  cursor: pointer;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-hover);
  user-select: none;
  list-style: none;
}
details.thinking > summary::-webkit-details-marker { display: none; }
details.thinking > summary::before {
  content: "▸ ";
  font-size: 10px;
  margin-right: 4px;
}
details.thinking[open] > summary::before { content: "▾ "; }
details.thinking > .thinking-body {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  font-size: 13px;
  color: var(--text-muted);
  white-space: pre-wrap;
}

/* ── toolCall block (collapsed by default) ─────────────── */
details.tool-call {
  margin: 8px 0 0;
  border: 1px solid rgba(34,197,94,0.25);
  border-radius: 8px;
  background: rgba(34,197,94,0.04);
  overflow: hidden;
}
details.tool-call.is-error {
  border-color: rgba(248,113,113,0.45);
  background: rgba(248,113,113,0.05);
}
details.tool-call > summary {
  cursor: pointer;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: #16a34a;
  list-style: none;
  user-select: none;
}
details.tool-call.is-error > summary { color: #f87171; }
details.tool-call > summary::-webkit-details-marker { display: none; }
details.tool-call > summary::before {
  content: "🔧 ";
  margin-right: 4px;
}
details.tool-call > summary::after {
  content: " ▸";
  font-size: 10px;
  color: var(--text-dim);
  margin-left: 6px;
}
details.tool-call[open] > summary::after { content: " ▾"; }
details.tool-call > .tool-call-body {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
details.tool-call .tool-call-input {
  margin: 0 0 8px;
  font-size: 12px;
  background: var(--bg-subtle);
  border-radius: 4px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}

/* ── Paired toolResult ────────────────────────────────── */
details.tool-result {
  margin: 6px 0 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--tool-bg);
  overflow: hidden;
}
details.tool-result > summary {
  cursor: pointer;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-muted);
  list-style: none;
  user-select: none;
}
details.tool-result > summary::-webkit-details-marker { display: none; }
details.tool-result > summary::before {
  content: "▸ ";
  font-size: 10px;
  margin-right: 4px;
}
details.tool-result[open] > summary::before { content: "▾ "; }
details.tool-result > .tool-result-body {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  font-size: 13px;
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 480px;
  overflow: auto;
}

/* ── Inline-attachment blocks (show_file outputs) ────── */
.attachment {
  margin: 8px 0 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
}
.attachment > .attachment-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-hover);
  font-family: var(--font-mono);
  word-break: break-all;
}
.attachment > .attachment-body {
  padding: 8px 12px;
}
.attachment img,
.attachment video,
.attachment audio {
  max-width: 100%;
  max-height: 480px;
  border-radius: 4px;
  display: block;
  margin: 0 auto;
}
.attachment iframe {
  width: 100%;
  height: 360px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
}
.attachment pre {
  margin: 0;
  background: var(--bg-subtle);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 10px;
  border-radius: 4px;
  max-height: 480px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.attachment.skipped {
  border-style: dashed;
  background: var(--bg-subtle);
}
.attachment.skipped > .attachment-header {
  background: transparent;
  color: var(--text-dim);
}
.attachment.skipped > .attachment-body {
  font-size: 12px;
  color: var(--text-dim);
  font-style: italic;
}
.attachment a.download-link {
  display: inline-block;
  margin-top: 4px;
  font-size: 12px;
}

/* ── Misc ──────────────────────────────────────────────── */
.export-footer {
  max-width: 880px;
  margin: 32px auto 0;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}
`;
