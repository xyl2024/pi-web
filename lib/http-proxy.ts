import { createLogger } from "@/lib/logger";

/**
 * Server-side HTTP proxy core. The /api/http route calls proxyFetch() with
 * an AbortController owned by the route (so the cancel route can find and
 * abort the same controller via the in-flight registry).
 *
 * The in-flight registry lives on globalThis so it survives Next.js HMR
 * reloads, mirroring the pattern in lib/rpc-manager.ts. On process exit /
 * SIGINT / SIGTERM every entry is aborted so we never leak a pending
 * upstream fetch on a graceful shutdown.
 */

const log = createLogger("lib/http-proxy");

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MIN_SIZE_LIMIT_BYTES = 1024;
export const MAX_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

export interface InFlightHandle {
  controller: AbortController;
  startedAt: number;
  url: string;
  method: string;
}

declare global {
  var __piHttpInFlight: Map<string, InFlightHandle> | undefined;
}

export function getInFlightRegistry(): Map<string, InFlightHandle> {
  if (!globalThis.__piHttpInFlight) {
    globalThis.__piHttpInFlight = new Map();
    const cleanup = () => {
      globalThis.__piHttpInFlight?.forEach((h) => {
        try {
          h.controller.abort();
        } catch {
          /* ignore */
        }
      });
      globalThis.__piHttpInFlight?.clear();
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piHttpInFlight;
}

export interface ProxyArgs {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: "text" | "base64";
  timeoutMs: number;
  sizeLimitBytes: number;
  signal: AbortSignal;
  logFields?: Record<string, unknown>;
}

export type ProxyResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      bodyEncoding: "text" | "base64";
      durationMs: number;
      size: number;
    }
  | {
      ok: false;
      error: "aborted" | "timeout" | "fetch_failed" | "body_too_large";
      message: string;
      durationMs: number;
    };

export async function proxyFetch(args: ProxyArgs): Promise<ProxyResult> {
  const startedAt = Date.now();
  const fields = args.logFields ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  // Bridge the caller's signal into our local controller. Either signal
  // (caller-side cancel from /api/http/[id]/cancel, or our timeout) aborts
  // the same fetch.
  const onCallerAbort = () => controller.abort();
  if (args.signal.aborted) controller.abort();
  args.signal.addEventListener("abort", onCallerAbort, { once: true });

  try {
    log.info("http proxy fetch start", {
      ...fields,
      method: args.method,
      url: args.url,
      timeoutMs: args.timeoutMs,
      sizeLimitBytes: args.sizeLimitBytes,
      bodyBytes: args.body ? args.body.length : 0,
    });

    let bodyBuf: Buffer | undefined;
    if (args.body !== undefined) {
      bodyBuf = args.bodyEncoding === "base64"
        ? Buffer.from(args.body, "base64")
        : Buffer.from(args.body, "utf8");
    }

    const res = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: bodyBuf as unknown as BodyInit | undefined,
      signal: controller.signal,
    });

    const buf = await res.arrayBuffer();
    const size = buf.byteLength;
    const durationMs = Date.now() - startedAt;

    if (size > args.sizeLimitBytes) {
      log.warn("http proxy body too large", { ...fields, url: args.url, size, limit: args.sizeLimitBytes, durationMs });
      return { ok: false, error: "body_too_large", message: `Response body too large (${size} > ${args.sizeLimitBytes} bytes)`, durationMs };
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    // Binary content types are returned base64-encoded so the client can
    // render images (data: URLs) or display the raw bytes without corruption
    // from a forced UTF-8 decode.
    const contentTypeHeader = (headers["content-type"] ?? "").toLowerCase();
    const isBinary = contentTypeHeader.startsWith("image/") || contentTypeHeader === "application/octet-stream";
    const body = isBinary
      ? Buffer.from(buf).toString("base64")
      : new TextDecoder().decode(buf);
    const bodyEncoding: "text" | "base64" = isBinary ? "base64" : "text";

    log.info("http proxy fetch done", { ...fields, url: args.url, status: res.status, size, durationMs, bodyEncoding });
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      bodyEncoding,
      durationMs,
      size,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || controller.signal.aborted) {
      // Distinguish caller-initiated abort (cancel route) from our own
      // timeout: the caller's signal is the one that fired if it was
      // already aborted when we entered, or if the timer hasn't elapsed.
      const wasTimeout = !args.signal.aborted;
      const kind = wasTimeout ? "timeout" : "aborted";
      log.warn("http proxy aborted", { ...fields, url: args.url, kind, durationMs });
      return {
        ok: false,
        error: kind,
        message: wasTimeout ? `Request timed out after ${args.timeoutMs}ms` : "Request aborted",
        durationMs,
      };
    }
    log.error("http proxy fetch failed", { ...fields, url: args.url, error: err, durationMs });
    return {
      ok: false,
      error: "fetch_failed",
      message: err instanceof Error ? err.message : String(err),
      durationMs,
    };
  } finally {
    clearTimeout(timer);
    args.signal.removeEventListener("abort", onCallerAbort);
  }
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}