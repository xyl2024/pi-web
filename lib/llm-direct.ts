// Shared "talk to an LLM without touching disk" helpers. Used by:
//   - app/api/translate/route.ts (translation panel — streaming)
//   - app/api/sessions/[id]/auto-name/route.ts (auto-naming — one-shot)
//
// Every route that needs an LLM call should go through `createDirectLlmSession`
// rather than re-implementing the in-memory AgentSession bootstrap. Keeping
// this in one place means model resolution logic, the no-disk loader, and
// the noTools/no-extensions guarantee stay in sync.

import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ResolvedModel {
  provider: string;
  modelId: string;
}

export interface DirectPromptOptions {
  /** System prompt prepended to the request. The user's text is passed as the single user message. */
  systemPrompt: string;
  /** Override the default model. When omitted, falls back to the user's default model from ~/.pi/agent/settings.json. */
  provider?: string;
  modelId?: string;
  /** Defaults to "off" — cheap-by-design calls (translate, auto-name) shouldn't waste tokens on extended thinking. */
  thinkingLevel?: ThinkingLevel;
  /** Inactivity timeout. If no prompt() completion within this window, the session is aborted. Defaults to 50s. */
  timeoutMs?: number;
}

// Custom loader that returns no extensions / skills / prompts / themes / agents
// files. Combined with SessionManager.inMemory() + SettingsManager.inMemory() +
// noTools: "all", this guarantees the request never touches disk, never reads
// ~/.pi/agent/settings.json, and never fires any extension hook.
function buildEmptyResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Resolve a model + provider pair. If both `provider` and `modelId` are passed,
 * they are used directly. Otherwise the user's default model from
 * ~/.pi/agent/settings.json is loaded (read-only; never written back).
 *
 * Throws with a descriptive message on failure so callers can surface it
 * directly to the user.
 */
export async function resolveDirectModel(opts?: { provider?: string; modelId?: string }): Promise<ResolvedModel> {
  const agentDir = getAgentDir();
  const cwd = process.cwd();
  const runtime = await ModelRuntime.create();

  if (opts?.provider && opts?.modelId) {
    const model = runtime.getModel(opts.provider, opts.modelId);
    if (!model) throw new Error(`Model not available: ${opts.provider}/${opts.modelId}`);
    return { provider: opts.provider, modelId: opts.modelId };
  }

  const settings = SettingsManager.create(cwd, agentDir);
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (!provider) {
    throw new Error("No default model configured in ~/.pi/agent/settings.json");
  }
  const model = runtime.getModel(provider, modelId ?? "");
  if (!model) {
    throw new Error(`Default model not available: ${provider}/${modelId ?? ""}`);
  }
  return { provider, modelId: modelId ?? "" };
}

/**
 * Create an in-memory LLM-only AgentSession. No tools, no extensions, no disk.
 *
 * The caller owns the returned session — call `dispose()` when done to free
 * the underlying SDK resources. For one-shot convenience, see `directPrompt`.
 */
export async function createDirectLlmSession(
  provider: string,
  modelId: string,
  systemPrompt: string,
  thinkingLevel: ThinkingLevel = "off",
): Promise<AgentSession> {
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`Model not available: ${provider}/${modelId}`);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({}),
    resourceLoader: buildEmptyResourceLoader(systemPrompt),
    model,
    thinkingLevel,
    noTools: "all",
  });

  return session;
}

/**
 * One-shot LLM call. Resolves the model, creates a session, sends the prompt,
 * waits for the assistant to finish (or aborts after `timeoutMs`), and returns
 * the accumulated text. Always disposes the session before returning.
 *
 * Throws on timeout, model resolution failure, or session creation failure.
 */
export async function directPrompt(promptText: string, opts: DirectPromptOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 50_000;
  const thinkingLevel = opts.thinkingLevel ?? "off";
  const resolved = await resolveDirectModel({ provider: opts.provider, modelId: opts.modelId });
  const agentSession = await createDirectLlmSession(
    resolved.provider,
    resolved.modelId,
    opts.systemPrompt,
    thinkingLevel,
  );

  let fullText = "";
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const unsub = agentSession.subscribe((event: { type: string; [k: string]: unknown }) => {
      if (event.type === "message_update") {
        const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (inner?.type === "text_delta" && typeof inner.delta === "string") {
          fullText += inner.delta;
        }
      }
    });

    await Promise.race([
      agentSession.prompt(promptText),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          agentSession.abort().catch(() => {});
          reject(new Error(`LLM call timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    try { unsub(); } catch { /* ignore */ }
    return fullText;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { agentSession.dispose(); } catch { /* ignore */ }
  }
}
