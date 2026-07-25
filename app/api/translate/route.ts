import { createLogger, elapsedMs } from "@/lib/logger";
import { createDirectLlmSession, resolveDirectModel } from "@/lib/llm-direct";
import {
  DEFAULT_TARGET_LANGUAGE,
  MAX_TRANSLATE_PROMPT_CHARS,
  TRANSLATE_PROMPTS,
  isLanguageCode,
  type LanguageCode,
} from "@/lib/translate";

export const dynamic = "force-dynamic";

const log = createLogger("api/translate");

const MAX_INPUT_CHARS = 8000;

interface TranslateRequestBody {
  text?: unknown;
  provider?: unknown;
  modelId?: unknown;
  target?: unknown;
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

  // Resolve the system prompt from the requested target language. Invalid or
  // missing values fall back to the default target — the client never gets to
  // choose an arbitrary prompt string.
  const target: LanguageCode = isLanguageCode(body.target)
    ? body.target
    : DEFAULT_TARGET_LANGUAGE;
  const systemPrompt = TRANSLATE_PROMPTS[target];
  if (systemPrompt.length > MAX_TRANSLATE_PROMPT_CHARS) {
    // Defensive — TRANSLATE_PROMPTS is static and curated well below this
    // limit, but a stale build / accidental edit should fail loudly rather
    // than silently ship a giant prompt.
    return Response.json(
      { error: `server prompt for target ${target} exceeds ${MAX_TRANSLATE_PROMPT_CHARS} characters` },
      { status: 500 },
    );
  }

  // Resolve model via the shared direct-LLM helper. The wrapper handles
  // reading ~/.pi/agent/settings.json (read-only) and falling back to the
  // user's default model when the client didn't pick one.
  let model: { provider: string; id: string };
  try {
    const resolved = await resolveDirectModel({
      provider: requestedProvider ?? undefined,
      modelId: requestedModelId ?? undefined,
    });
    model = { provider: resolved.provider, id: resolved.modelId };
  } catch (error) {
    log.error("translate model resolve failed", { error, durationMs: elapsedMs(startedAt) });
    return Response.json({ error: `Failed to resolve model: ${String(error)}` }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let session: { prompt: (text: string) => Promise<unknown>; subscribe: (handler: (e: { type: string; [k: string]: unknown }) => void) => () => void; abort: () => Promise<void>; dispose: () => void } | null = null;
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
        const created = await createDirectLlmSession(
          model.provider,
          model.id,
          systemPrompt,
          "off",
        );
        session = created;
        log.info("translate session created", {
          model: { provider: model.provider, id: model.id },
          target,
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