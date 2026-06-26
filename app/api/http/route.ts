import { NextResponse } from "next/server";
import { createLogger, elapsedMs } from "@/lib/logger";
import {
  proxyFetch,
  getInFlightRegistry,
  clampInt,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SIZE_LIMIT_BYTES,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_SIZE_LIMIT_BYTES,
  MAX_SIZE_LIMIT_BYTES,
} from "@/lib/http-proxy";

export const dynamic = "force-dynamic";

const log = createLogger("api/http");

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

interface RequestBody {
  id?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: "text" | "base64";
  timeoutMs?: number;
  sizeLimitBytes?: number;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  let id = "";
  try {
    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    id = typeof body.id === "string" && body.id ? body.id : "";
    const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
    const url = typeof body.url === "string" ? body.url : "";

    if (!id) return jsonError("id required", 400);
    if (!url) return jsonError("url required", 400);
    if (!ALLOWED_METHODS.has(method)) return jsonError(`Unsupported method: ${method}`, 400);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return jsonError("Invalid url", 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return jsonError("Only http(s) URLs are allowed", 400);
    }

    const timeoutMs = clampInt(body.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const sizeLimitBytes = clampInt(body.sizeLimitBytes, MIN_SIZE_LIMIT_BYTES, MAX_SIZE_LIMIT_BYTES, DEFAULT_SIZE_LIMIT_BYTES);

    const controller = new AbortController();
    const registry = getInFlightRegistry();
    registry.set(id, { controller, startedAt, url, method });

    // Forward the client's disconnect into the controller so closing the tab
    // releases the upstream fetch promptly (mirror of auth/login pattern).
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const headers = body.headers && typeof body.headers === "object" ? body.headers : undefined;
    const fetchBody = typeof body.body === "string" ? body.body : undefined;
    const bodyEncoding = body.bodyEncoding === "base64" ? "base64" : "text";

    try {
      const result = await proxyFetch({
        method,
        url,
        headers,
        body: fetchBody,
        bodyEncoding,
        timeoutMs,
        sizeLimitBytes,
        signal: controller.signal,
        logFields: { id },
      });

      log.info("http request done", { id, method, url, ok: result.ok, durationMs: elapsedMs(startedAt) });

      if (result.ok) {
        return NextResponse.json({ id, ...result });
      }

      // Map error kinds to HTTP status codes.
      const status =
        result.error === "timeout" ? 504 :
        result.error === "aborted" ? 499 :
        result.error === "body_too_large" ? 502 :
        502;
      return NextResponse.json({ ok: false, id, error: result.error, message: result.message, durationMs: result.durationMs }, { status });
    } finally {
      registry.delete(id);
    }
  } catch (err) {
    log.error("http request crashed", { id, error: err, durationMs: elapsedMs(startedAt) });
    return jsonError(err instanceof Error ? err.message : String(err), 500);
  }
}