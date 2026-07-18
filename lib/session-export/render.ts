// Pure function: render a session as a self-contained HTML document.
//
// Designed to be called from the route handler in app/api/sessions/[id]/export.
// Output is meant to be `text/html; charset=utf-8` written directly into a
// NextResponse — no streaming, no JS interactivity required.
//
// What is rendered:
//   - header (title + date + model/thinkingLevel label)
//   - each message in order, paired with its toolResult when present
//   - assistant text blocks → markdown (via `marked`)
//   - assistant thinking blocks → collapsed <details>
//   - assistant toolCall blocks → collapsed <details>, and:
//     - if toolName === "show_file": paths in block.input.paths[] are looked up
//       in ctx.attachments; each becomes an inline data: URL or a "skipped" box
//     - otherwise: JSON-formatted args; paired toolResult blocks (if any) follow
//   - user images: data: URL when source.type === "base64" (file already
//     embedded in the JSONL); plain <img src="url"> for url-type sources
//     (best-effort — receiver may need network access)
//
// What is NOT rendered:
//   - payload captures (request/response body — those are in-memory only)
//   - toolResult messages without a matching toolCall (orphan — rendered standalone)
//   - remote URL images outside `data:` protocol (browser handles fetch)

import { SHOW_FILE_TOOL_NAME } from "@/lib/show-file-tool-types";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";
import { type Locale } from "@/lib/i18n-dict";

import type { AttachmentResult } from "@/lib/session-export/inline-fs";
import { escapeHtml } from "@/lib/session-export/html-escape";
import { renderMarkdown } from "@/lib/session-export/markdown";
import { EXPORT_CSS } from "@/lib/session-export/styles";

export interface SessionRenderContext {
  title: string;
  date: string; // YYYY-MM-DD, locale-stable
  modelLabel: string; // e.g. "claude-sonnet-4-6"
  thinkingLevelLabel: string; // e.g. "medium"
  locale: Locale;
  messages: AgentMessage[];
  /** Map of `show_file` toolCall path → inline result, pre-computed by the caller. */
  attachments: Map<string, AttachmentResult>;
}

export function renderHtml(ctx: SessionRenderContext): string {
  const docLang = ctx.locale === "zh" ? "zh-CN" : "en";

  // Pre-compute toolCallId → toolResult lookup so renderer can pair inline.
  const toolResultsById = new Map<string, ToolResultMessage>();
  for (const m of ctx.messages) {
    if (m.role === "toolResult") {
      toolResultsById.set(m.toolCallId, m);
    }
  }

  const body: string[] = [];
  body.push(renderHeader(ctx));
  body.push('<main class="messages">');
  for (const m of ctx.messages) {
    body.push(...renderMessage(m, ctx, toolResultsById));
  }
  body.push("</main>");
  body.push(renderFooter());

  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(docLang)}">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="generator" content="pi-web export">`,
    `<meta name="locale" content="${escapeHtml(ctx.locale)}">`,
    `<title>${escapeHtml(ctx.title)}</title>`,
    `<style>${EXPORT_CSS}</style>`,
    "</head>",
    '<body class="theme-export">',
    body.join("\n"),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ─── Header ────────────────────────────────────────────────
function renderHeader(ctx: SessionRenderContext): string {
  const parts: string[] = [];
  if (ctx.date) parts.push(ctx.date);
  if (ctx.modelLabel) parts.push(escapeHtml(ctx.modelLabel));
  if (ctx.thinkingLevelLabel) parts.push(`thinking: ${escapeHtml(ctx.thinkingLevelLabel)}`);
  return [
    '<header class="export-header">',
    `<h1>${escapeHtml(ctx.title)}</h1>`,
    `<p class="export-meta">${parts.join(" · ")}</p>`,
    "</header>",
  ].join("\n");
}

// ─── Footer ────────────────────────────────────────────────
function renderFooter(): string {
  return '<footer class="export-footer">Exported from pi-web</footer>';
}

// ─── Per-message dispatch ──────────────────────────────────
function renderMessage(
  m: AgentMessage,
  ctx: SessionRenderContext,
  toolResultsById: Map<string, ToolResultMessage>,
): string[] {
  switch (m.role) {
    case "user":
      return [renderUserMessage(m, ctx)];
    case "assistant":
      return renderAssistantMessage(m, ctx, toolResultsById);
    case "toolResult":
      // Standalone toolResult (no matching toolCall) — collapse as orphan.
      return [renderOrphanToolResult(m)];
    case "custom":
      // Custom messages are mostly internal — skip them silently.
      return [];
  }
}

// ─── User ──────────────────────────────────────────────────
function renderUserMessage(m: UserMessage, _ctx: SessionRenderContext): string {
  const blocks = typeof m.content === "string"
    ? [{ type: "text", text: m.content } as TextContent]
    : m.content;

  const textHtml = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => `<div class="markdown-body">${renderMarkdown(b.text)}</div>`)
    .join("\n");

  const imageHtml = blocks
    .filter((b): b is ImageContent => b.type === "image")
    .map(renderImageContent)
    .join("");

  return [
    '<section class="msg msg-user">',
    '<div class="msg-header"><span class="msg-role">User</span></div>',
    '<div class="msg-body">',
    textHtml,
    imageHtml ? `<div class="msg-images">${imageHtml}</div>` : "",
    "</div>",
    "</section>",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderImageContent(img: ImageContent): string {
  const src = img.source?.type === "base64"
    ? `data:${img.source.media_type ?? "image/png"};base64,${img.source.data ?? ""}`
    : img.source?.type === "url"
      ? img.source.url ?? ""
      : "";
  if (!src) return "";
  const alt = escapeHtml(img.source?.media_type ?? "image");
  return `<img src="${escapeHtml(src)}" alt="${alt}">`;
}

// ─── Assistant ─────────────────────────────────────────────
function renderAssistantMessage(
  m: AssistantMessage,
  ctx: SessionRenderContext,
  toolResultsById: Map<string, ToolResultMessage>,
): string[] {
  const out: string[] = [];
  const headerBits: string[] = [];
  headerBits.push(`<span class="msg-role">Assistant</span>`);
  if (m.model) headerBits.push(`<span>${escapeHtml(formatModelLabel(m))}</span>`);

  out.push('<section class="msg msg-assistant">');
  out.push(`<div class="msg-header">${headerBits.join("")}</div>`);
  out.push('<div class="msg-body">');

  for (const block of m.content) {
    out.push(...renderAssistantBlock(block, ctx, toolResultsById));
  }
  out.push("</div>");
  out.push("</section>");
  return out;
}

function formatModelLabel(m: AssistantMessage): string {
  const id = m.model ? m.model : "model";
  // m.model is the pi-sdk model id (often "claude-sonnet-4-6"); provider is separate.
  return `${id}`;
}

function renderAssistantBlock(
  block: AssistantContentBlock,
  ctx: SessionRenderContext,
  toolResultsById: Map<string, ToolResultMessage>,
): string[] {
  switch (block.type) {
    case "text":
      return [`<div class="markdown-body">${renderMarkdown(block.text)}</div>`];
    case "thinking":
      return [renderThinkingBlock(block)];
    case "image":
      return [renderImageContent(block)];
    case "toolCall":
      return renderToolCallBlock(block, ctx, toolResultsById);
  }
}

function renderThinkingBlock(b: ThinkingContent): string {
  const text = escapeHtml(b.thinking);
  return [
    '<details class="thinking">',
    "<summary>Thinking</summary>",
    `<div class="thinking-body">${text}</div>`,
    "</details>",
  ].join("\n");
}

function renderToolCallBlock(
  block: ToolCallContent,
  ctx: SessionRenderContext,
  toolResultsById: Map<string, ToolResultMessage>,
): string[] {
  const out: string[] = [];
  const result = toolResultsById.get(block.toolCallId);
  const isError = result?.isError === true;
  const classes = isError ? "details tool-call is-error" : "details tool-call";
  const argsJson = escapeHtml(safeStringify(block.input));

  out.push(`<${classes}>`);
  out.push(`<summary>${escapeHtml(block.toolName)}</summary>`);
  out.push('<div class="tool-call-body">');
  if (block.toolName === SHOW_FILE_TOOL_NAME) {
    out.push(...renderShowFileInputs(block, ctx));
  } else {
    out.push(`<pre class="tool-call-input">${argsJson}</pre>`);
  }
  out.push("</div>");
  out.push("</details>");

  // Paired result, if any (and not orphaned).
  if (result && block.toolName !== SHOW_FILE_TOOL_NAME) {
    out.push(renderPairedToolResult(result));
  }

  return out;
}

function renderShowFileInputs(
  block: ToolCallContent,
  ctx: SessionRenderContext,
): string[] {
  const paths = extractPaths(block.input);
  const out: string[] = [];
  if (paths.length === 0) {
    out.push('<pre class="tool-call-input">(no paths)</pre>');
    return out;
  }
  for (const p of paths) {
    out.push(...renderAttachment(p, ctx.attachments.get(p)));
  }
  return out;
}

function extractPaths(input: Record<string, unknown>): string[] {
  const raw = input.paths;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
}

function renderAttachment(path: string, attachment: AttachmentResult | undefined): string[] {
  if (!attachment || attachment.kind === "skipped") {
    return renderSkippedAttachment(path, attachment);
  }
  return renderInlineAttachment(path, attachment.mime, attachment.base64);
}

function renderInlineAttachment(path: string, mime: string, base64: string): string[] {
  const href = `data:${escapeHtml(mime)};base64,${base64}`;
  const headerLabel = escapeHtml(path);
  const body = renderInlineAttachmentBody(mime, href, path);

  return [
    '<section class="attachment">',
    `<div class="attachment-header"><span>${headerLabel}</span><span>${escapeHtml(mime)}</span></div>`,
    `<div class="attachment-body">${body}</div>`,
    "</section>",
  ];
}

function renderInlineAttachmentBody(mime: string, href: string, path: string): string {
  const safeHref = escapeHtml(href);
  if (mime.startsWith("image/")) {
    return `<img src="${safeHref}" alt="${escapeHtml(path)}">`;
  }
  if (mime.startsWith("video/")) {
    return `<video src="${safeHref}" controls></video>`;
  }
  if (mime.startsWith("audio/")) {
    return `<audio src="${safeHref}" controls></audio>`;
  }
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    // Don't trust remote HTML inside a srcdoc — but this came from disk via the
    // tool's allowlist so it's safe; sandbox with srcdoc.
    return `<iframe sandbox srcdoc="${safeHref.replace(/"/g, "&quot;")}"></iframe>`;
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    return `<a class="download-link" href="${safeHref}" download="${escapeHtml(path)}">Download ${escapeHtml(path)}</a>`;
  }
  // Generic binary
  return `<a class="download-link" href="${safeHref}" download="${escapeHtml(path)}">Download ${escapeHtml(path)}</a>`;
}

function renderSkippedAttachment(path: string, attachment: AttachmentResult | undefined): string[] {
  const reason = attachment?.kind === "skipped" ? attachment.reason : "missing";
  const sizeStr = (attachment?.kind === "skipped" && typeof attachment.size === "number")
    ? ` (${attachment.size} B)`
    : "";
  const reasonText = reason === "too-large"
    ? `skipped (too large${sizeStr})`
    : reason === "not-allowed"
      ? "skipped (not in allowed roots)"
      : "skipped (missing)";
  return [
    '<section class="attachment skipped">',
    `<div class="attachment-header"><span>${escapeHtml(path)}</span></div>`,
    `<div class="attachment-body">${escapeHtml(reasonText)}</div>`,
    "</section>",
  ];
}

function renderPairedToolResult(result: ToolResultMessage): string {
  const text = collectTextFromContent(result.content);
  const isError = result.isError === true;
  const summary = isError ? `Result · error` : `Result`;
  const body = text
    ? `<pre>${escapeHtml(text)}</pre>`
    : '<em style="color: var(--text-dim)">(empty)</em>';
  return [
    `<details class="tool-result">`,
    `<summary>${escapeHtml(summary)}</summary>`,
    `<div class="tool-result-body">${body}</div>`,
    "</details>",
  ].join("\n");
}

function renderOrphanToolResult(result: ToolResultMessage): string {
  return renderPairedToolResult(result);
}

function collectTextFromContent(content: ToolResultMessage["content"]): string {
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
