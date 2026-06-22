import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createLogger, elapsedMs } from "@/lib/logger";
import { DEFAULT_TRANSLATE_PROMPT, MAX_TRANSLATE_PROMPT_CHARS } from "@/lib/translate";

export const dynamic = "force-dynamic";

const log = createLogger("api/translate");

const MAX_INPUT_CHARS = 8000;

// Custom loader that returns no extensions/skills/prompts/themes/agents files.
// Combined with SessionManager.inMemory() + SettingsManager.inMemory() +
// noTools:"all", this guarantees the translate request never touches disk,
// never reads ~/.pi/agent/settings.json, and never fires any extension hook.
function buildTranslateResourceLoader(systemPrompt: string): ResourceLoader {
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

interface TranslateRequestBody {
  text?: unknown;
  provider?: unknown;
  modelId?: unknown;
  systemPrompt?: unknown;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  let body: TranslateRequestBody;
  try {
    body = (await req.json()) as TranslateRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  const trimmed = text.trim();
  if (!trimmed) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  if (trimmed.length > MAX_INPUT_CHARS) {
    return Response.json(
      { error: `text exceeds ${MAX_INPUT_CHARS} characters` },
      { status: 400 },
    );
  }

  const requestedProvider = typeof body.provider === "string" ? body.provider : null;
  const requestedModelId = typeof body.modelId === "string" ? body.modelId : null;

  // systemPrompt is optional. Empty / missing → use the built-in default.
  let systemPrompt: string = DEFAULT_TRANSLATE_PROMPT;
  if (typeof body.systemPrompt === "string") {
    const trimmedPrompt = body.systemPrompt.trim();
    if (trimmedPrompt.length > 0) {
      if (trimmedPrompt.length > MAX_TRANSLATE_PROMPT_CHARS) {
        return Response.json(
          { error: `systemPrompt exceeds ${MAX_TRANSLATE_PROMPT_CHARS} characters` },
          { status: 400 },
        );
      }
      systemPrompt = trimmedPrompt;
    }
  }

  // Resolve model. Mirror app/api/models/route.ts: use defaults from a separate
  // (read-only) SettingsManager when the client didn't pick one. We deliberately
  // do NOT pass this SettingsManager to createAgentSession — that one uses an
  // empty in-memory manager so the user's real ~/.pi/agent/settings.json is
  // not consulted at all.
  let model;
  try {
    const agentDir = getAgentDir();
    const cwd = process.cwd();
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);

    if (requestedProvider && requestedModelId) {
      model = registry.find(requestedProvider, requestedModelId);
      if (!model) {
        return Response.json(
          { error: `Model not available: ${requestedProvider}/${requestedModelId}` },
          { status: 400 },
        );
      }
    } else {
      const settings = SettingsManager.create(cwd, agentDir);
      const provider = settings.getDefaultProvider();
      const modelId = settings.getDefaultModel();
      if (!provider) {
        return Response.json(
          { error: "No default model configured in ~/.pi/agent/settings.json" },
          { status: 400 },
        );
      }
      model = registry.find(provider, modelId ?? "");
      if (!model) {
        return Response.json(
          { error: `Default model not available: ${provider}/${modelId}` },
          { status: 400 },
        );
      }
    }
  } catch (error) {
    log.error("translate model resolve failed", { error, durationMs: elapsedMs(startedAt) });
    return Response.json({ error: `Failed to resolve model: ${String(error)}` }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let session: { abort: () => Promise<void>; dispose: () => void } | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // controller already closed (client disconnected)
          closed = true;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
        if (session) {
          session.abort().catch(() => {});
          try { session.dispose(); } catch {}
          session = null;
        }
        try { controller.close(); } catch {}
      };

      // Heartbeat every 30s — keeps proxies from killing the stream.
      heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(":\n\n")); } catch { closed = true; }
      }, 30_000);

      req.signal?.addEventListener("abort", cleanup);

      try {
        const { session: created } = await createAgentSession({
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory({}),
          resourceLoader: buildTranslateResourceLoader(systemPrompt),
          model,
          thinkingLevel: "off",
          noTools: "all",
        });
        session = created;
        log.info("translate session created", {
          model: { provider: model.provider, id: model.id },
          promptSource: systemPrompt === DEFAULT_TRANSLATE_PROMPT ? "default" : "custom",
          durationMs: elapsedMs(startedAt),
        });

        unsubscribe = created.subscribe((event: { type: string; [k: string]: unknown }) => {
          if (event.type === "message_update") {
            const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
            if (inner?.type === "text_delta" && typeof inner.delta === "string") {
              send({ type: "delta", text: inner.delta });
            }
          } else if (event.type === "agent_end") {
            const willRetry = (event as { willRetry?: boolean }).willRetry === true;
            if (!willRetry) {
              send({ type: "done", modelId: `${model.provider}/${model.id}` });
              cleanup();
            }
          }
        });

        await created.prompt(trimmed);
      } catch (error) {
        log.error("translate failed", { error, durationMs: elapsedMs(startedAt) });
        send({ type: "error", message: String(error) });
        cleanup();
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
      if (session) {
        session.abort().catch(() => {});
        try { session.dispose(); } catch {}
        session = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}