// Types mirrored from pi-mono coding-agent session-manager

interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string; // set if this session was forked from another
  // True while the agent is between agent_start and agent_end (or compacting).
  // Set by the read layer to false; the /api/sessions route enriches from the
  // wrapper registry.
  running: boolean;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

// RPC types
export interface SessionSearchResult {
  id: string;
  name?: string;
  cwd: string;
  modified: string;
  matchCount: number;
  snippet: string; // \u0000-delimited keyword markers for frontend highlighting
  /** entry.id of the first matching message — used to jump to that message on open */
  firstMatchEntryId?: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  hasMore: boolean;
}

/** A single message-level match within a session file */
export interface SessionMessageSearchResult {
  /** entry.id of the matching message */
  entryId: string;
  /** message role: user | assistant | toolResult */
  role: string;
  /** \u0000-delimited snippet for frontend <mark> highlighting */
  snippet: string;
  /** leaf entry id reachable from this message — used to switch branch when jumping */
  leafId: string;
  /** message timestamp if available */
  timestamp?: string;
}

export interface SessionMessageSearchResponse {
  /** First N results with snippets (for the result list) */
  results: SessionMessageSearchResult[];
  /** All matching entryIds (for <mark> highlighting in messages) */
  matchedEntryIds: string[];
  /** Total number of matching entryIds */
  totalMatches: number;
}

export interface AgentsFile {
  path: string;
  content: string;
  label: string;
}
