// Pure helpers for classifying assistant-message content blocks.
//
// Used by the chat window to split an assistant message into "process"
// (thinking + tool calls + intermediate text) and "answer" (the trailing
// text/image blocks that should always stay visible). The split powers
// the per-turn "Process details" foldable group.

import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ThinkingContent,
} from "./types";
import { SHOW_FILE_TOOL_NAME } from "./show-file-tool-types";

interface DisplayOptions {
  isStreaming?: boolean;
}

/** Drop completed thinking blocks that have no content. Streaming thinking
 *  blocks are kept even when empty so the live spinner remains visible. */
export function isEmptyThinkingBlock(
  block: AssistantContentBlock,
  options: DisplayOptions = {},
): block is ThinkingContent {
  return (
    block.type === "thinking" &&
    !options.isStreaming &&
    block.thinking.trim() === ""
  );
}

/** Visible assistant blocks for a message, with empty thinking blocks removed. */
export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter(
    (block) => !isEmptyThinkingBlock(block, options),
  );
}

/** Returns the trimmed errorMessage for a stopped-with-error assistant
 *  message, or null. Streaming messages never surface an error. */
export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/** Final-answer blocks are text and images. Thinking + tool calls are process. */
function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

/**
 * Split the final assistant message into trailing-answer and leading-process
 * blocks. "Final" is defined as the suffix of consecutive text/image blocks
 * after the last thinking/tool-call block. Anything before that boundary —
 * including text emitted between tools — stays in the process group.
 */
export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex(
    (block) => !isFinalAnswerBlock(block),
  );
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

/** Collect every path referenced by a list of assistant content blocks,
 *  in order. Backs collectShowFilePaths for a single block list. */
export function collectShowFilePathsFromBlocks(blocks: AssistantContentBlock[]): string[] {
  const paths: string[] = [];
  for (const b of blocks) {
    if (b.type !== "toolCall") continue;
    if (b.toolName !== SHOW_FILE_TOOL_NAME) continue;
    const raw = b.input.paths;
    if (!Array.isArray(raw)) continue;
    for (const p of raw) {
      if (typeof p === "string" && p.length > 0) paths.push(p);
    }
  }
  return paths;
}

/** Collect every show_file path referenced across the message range
 *  [from, to) in order. Used to render the turn-level file gallery below
 *  the final answer instead of inside the foldable tool-call cards. */
export function collectShowFilePaths(
  messages: AgentMessage[],
  from: number,
  to: number,
): string[] {
  const paths: string[] = [];
  const end = Math.min(to, messages.length);
  for (let i = from; i < end; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    paths.push(...collectShowFilePathsFromBlocks(msg.content ?? []));
  }
  return paths;
}

/** Count tool-call blocks by tool name across message indices plus extra
 *  blocks (used to summarise the process group, e.g. "3× bash, 2× read"). */
export function countToolCallsByName(
  messages: AgentMessage[],
  indices: number[],
  extraBlocks: AssistantContentBlock[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const tally = (blocks: AssistantContentBlock[]) => {
    for (const b of blocks) {
      if (b.type === "toolCall") {
        counts[b.toolName] = (counts[b.toolName] ?? 0) + 1;
      }
    }
  };
  for (const i of indices) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    tally(msg.content ?? []);
  }
  tally(extraBlocks);
  return counts;
}