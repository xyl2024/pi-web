import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Socket } from "node:net";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { createLogger, elapsedMs } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createLogger("api/github/contributions");

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_DIR = join(homedir(), ".pi-web", ".cache", "github-contributions");
const UPSTREAM_BASE = "https://github-contributions-api.jogruber.de/v4";
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const USER_AGENT = `pi-web/${APP_VERSION}`;
const FETCH_TIMEOUT_MS = 15_000;

interface ContributionDay {
  date: string;
  count: number;
  level: number;
}

interface CacheFile {
  contributions: ContributionDay[];
  total: number;
  fetchedAt: number;
  upstreamStatus: number;
}

interface UpstreamResponse {
  total: Record<string, number>;
  contributions: ContributionDay[];
}

function cachePathFor(user: string): string {
  // Sanitize to prevent path traversal — usernames may only contain alnum, dash, underscore, dot.
  const safe = user.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CACHE_DIR, `${safe}.json`);
}

function readCache(user: string): CacheFile | null {
  try {
    const raw = readFileSync(cachePathFor(user), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (!Array.isArray(parsed.contributions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(user: string, data: CacheFile): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePathFor(user), JSON.stringify(data), "utf8");
  } catch (err) {
    log.warn("cache write failed", { user, error: String(err) });
  }
}

/**
 * Read the system HTTPS proxy env. Node's global `fetch` does not honor these
 * (only the `dispatcher` option does), so in proxied environments we must
 * tunnel manually. Returns null if no proxy is set or the URL is invalid.
 */
function getHttpsProxyUrl(): URL | null {
  const raw =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    null;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    log.warn("invalid proxy env URL, ignoring", { raw });
    return null;
  }
}

/**
 * HTTPS GET through an HTTP CONNECT tunnel. Used when an HTTPS_PROXY is set
 * and `fetch` can't reach the upstream directly (e.g. WSL2 + Clash).
 */
function httpsGetViaProxy(
  target: URL,
  headers: Record<string, string>,
  proxy: URL,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const port = target.port ? Number(target.port) : 443;
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : 80,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}` },
      timeout: timeoutMs,
    });

    const onTunnelError = (err: Error) => {
      connectReq.destroy();
      reject(err);
    };

    connectReq.on("connect", (res, socket) => {
      connectReq.removeListener("error", onTunnelError);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
        return;
      }

      // The `socket` option is accepted at runtime to reuse the CONNECT-tunneled
      // socket for the TLS handshake, but is not exposed in the public
      // RequestOptions type. Intersect with `{ socket?: Socket }` to keep tsc happy.
      const opts: RequestOptions & { socket?: Socket } = {
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
        socket,
        agent: false,
        timeout: timeoutMs,
      };

      const req = httpsRequest(opts, (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { data += chunk; });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: data });
        });
        response.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("https request timeout"));
      });
      req.end();
    });

    connectReq.on("error", onTunnelError);
    connectReq.on("timeout", () => {
      connectReq.destroy(new Error("proxy CONNECT timeout"));
    });
    connectReq.end();
  });
}

async function fetchUpstream(user: string): Promise<UpstreamResponse | null> {
  const url = `${UPSTREAM_BASE}/${encodeURIComponent(user)}?y=last`;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
  const proxy = getHttpsProxyUrl();

  try {
    let status: number;
    let body: string;

    if (proxy) {
      log.debug("upstream via CONNECT proxy", { user, proxy: proxy.origin });
      const r = await httpsGetViaProxy(new URL(url), headers, proxy, FETCH_TIMEOUT_MS);
      status = r.status;
      body = r.body;
    } else {
      const res = await fetch(url, { headers, cache: "no-store" });
      status = res.status;
      body = await res.text();
    }

    if (status !== 200) {
      log.warn("upstream non-ok", { user, status });
      return null;
    }
    const data = JSON.parse(body) as UpstreamResponse;
    if (!data || !Array.isArray(data.contributions)) {
      log.warn("upstream malformed payload", { user });
      return null;
    }
    return data;
  } catch (err) {
    log.warn("upstream fetch failed", { user, error: String(err) });
    return null;
  }
}

export async function GET() {
  const startedAt = Date.now();
  try {
    const config = readConfig();
    const username = (config.github_username ?? "").trim();

    if (!username) {
      log.debug("github heatmap: no username configured");
      return NextResponse.json({
        contributions: [],
        total: 0,
        username: "",
        updatedAt: 0,
      });
    }

    const cached = readCache(username);
    const now = Date.now();
    const isFresh = cached !== null && now - cached.fetchedAt < CACHE_TTL_MS;

    if (isFresh && cached) {
      log.info("github heatmap: cache hit", { user: username, ageMs: now - cached.fetchedAt, durationMs: elapsedMs(startedAt) });
      return NextResponse.json({
        contributions: cached.contributions,
        total: cached.total,
        username,
        updatedAt: cached.fetchedAt,
      });
    }

    const upstream = await fetchUpstream(username);
    if (upstream) {
      const next: CacheFile = {
        contributions: upstream.contributions,
        total: upstream.contributions.reduce((acc, d) => acc + d.count, 0),
        fetchedAt: now,
        upstreamStatus: 200,
      };
      writeCache(username, next);
      log.info("github heatmap: upstream fetched", {
        user: username,
        days: upstream.contributions.length,
        durationMs: elapsedMs(startedAt),
      });
      return NextResponse.json({
        contributions: next.contributions,
        total: next.total,
        username,
        updatedAt: next.fetchedAt,
      });
    }

    // Upstream failed — fall back to stale cache if we have one.
    if (cached) {
      log.warn("github heatmap: serving stale cache after upstream failure", {
        user: username,
        ageMs: now - cached.fetchedAt,
        durationMs: elapsedMs(startedAt),
      });
      return NextResponse.json({
        contributions: cached.contributions,
        total: cached.total,
        username,
        updatedAt: cached.fetchedAt,
        stale: true,
      });
    }

    log.error("github heatmap: upstream unavailable, no cache", { user: username, durationMs: elapsedMs(startedAt) });
    return NextResponse.json(
      { error: "upstream_unavailable", contributions: [], total: 0, username },
      { status: 502 },
    );
  } catch (error) {
    log.error("github heatmap: handler failed", { error: String(error), durationMs: elapsedMs(startedAt) });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
