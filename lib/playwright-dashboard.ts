import { spawn, type ChildProcess } from "child_process";
import http from "http";
import { createLogger } from "./logger";

const log = createLogger("playwright-dashboard");

const DEFAULT_PORT = 4321;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 250;
const PORT_TRIES = 10;

interface DashboardState {
  child: ChildProcess | null;
  url: string | null;
  port: number | null;
  pid: number | null;
  ready: Promise<boolean>;
  lastError: string | null;
}

declare global {
  var __piWebDashboard: DashboardState | undefined;
}

function getState(): DashboardState {
  if (!globalThis.__piWebDashboard) {
    globalThis.__piWebDashboard = {
      child: null,
      url: null,
      port: null,
      pid: null,
      ready: Promise.resolve(false),
      lastError: null,
    };
  }
  return globalThis.__piWebDashboard;
}

function probeOnce(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/index.html", timeout: timeoutMs },
      (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function probeReady(port: number): Promise<boolean> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeOnce(port, 1000)) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return false;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(preferred: number): Promise<number> {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = preferred + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `No free playwright dashboard port in range ${preferred}-${preferred + PORT_TRIES - 1}`
  );
}

async function spawnDashboard(preferred: number): Promise<void> {
  const port = await pickPort(preferred);
  const child = spawn(
    "playwright-cli",
    ["show", "--host=127.0.0.1", `--port=${port}`],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  const pid = child.pid ?? null;

  child.once("exit", (code, signal) => {
    const state = getState();
    if (state.child === child) {
      state.child = null;
      state.url = null;
      state.port = null;
      state.pid = null;
      state.lastError = `playwright-cli exited (code=${code}, signal=${signal})`;
      log.warn("playwright dashboard exited", { port, pid, code, signal });
    }
  });

  const state = getState();
  state.child = child;
  state.port = port;
  state.pid = pid;
  state.lastError = null;

  const ok = await probeReady(port);
  if (!ok) {
    state.lastError = "Dashboard failed to start within timeout";
    log.warn("playwright dashboard not ready", { port, pid });
    return;
  }
  state.url = `http://127.0.0.1:${port}/`;
  log.info("playwright dashboard ready", { url: state.url, pid });
}

export async function startDashboard(): Promise<void> {
  const state = getState();
  if (state.child) return;
  const preferred = Number(process.env.PI_WEB_DASHBOARD_PORT) || DEFAULT_PORT;
  state.ready = (async () => {
    try {
      await spawnDashboard(preferred);
      return state.url !== null;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      log.error("playwright dashboard spawn failed", { error });
      return false;
    }
  })();
  await state.ready;
}

export function getDashboardUrl(): string | null {
  return getState().url;
}

export async function getDashboardStatus(): Promise<{
  url: string | null;
  ready: boolean;
  pid: number | null;
  error: string | null;
}> {
  let state = getState();
  if (!state.child) {
    // Lazy start — fire and forget so the first GET is fast; subsequent
    // polls will pick up the resolved URL once the probe succeeds.
    void startDashboard();
    state = getState();
  }
  const ready = await state.ready;
  return { url: state.url, ready, pid: state.pid, error: state.lastError };
}

export function stopDashboard(): void {
  const state = getState();
  if (state.child && state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  state.child = null;
  state.url = null;
  state.port = null;
  state.pid = null;
  state.lastError = null;
  state.ready = Promise.resolve(false);
}

let cleanupRegistered = false;
export function ensureCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("SIGTERM", stopDashboard);
  process.once("SIGINT", stopDashboard);
  process.once("exit", stopDashboard);
}