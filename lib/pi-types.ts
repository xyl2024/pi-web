import type { SessionManager, SettingsManager, AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";

interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly model: ModelLike | undefined;
  readonly modelRuntime: Pick<ModelRuntime, "getModel" | "getModels">;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly agent: { state?: { systemPrompt?: string; thinkingLevel?: string } };

  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void>;
  abort(): Promise<void>;
  setModel(model: ModelLike): Promise<void>;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult>;
  setThinkingLevel(level: string): void;
  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  getContextUsage(): ContextUsage | undefined;
}
