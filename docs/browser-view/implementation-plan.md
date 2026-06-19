# pi-web 浏览器实时查看——实施计划

> 配套设计文档：[`./design.md`](./design.md)。在动手之前务必先读完那份，并把它当作争议仲裁来源。

> 目标读者：负责落地实现的下一个 claude code（或人）。本文档按**可执行步骤**组织；每一步都给出**要新建/修改哪些文件、改成什么样、怎么验证**。所有源代码引用都用 `path:line` 标注，方便核对上游是否已经漂移。

> 总投入：约 3 天（推荐 4 个阶段，阶段 0–2 是 v1 必须，阶段 3–4 可选）。下面按阶段拆分。

---

## 0. 前置检查与前提

在动手之前，**先把这四件事跑通**，否则后面会卡住：

### 0.1 确认上游文件没漂移

打开下面这些文件，确认行号和设计文档里一致。如果行号漂移超过 ±20 行，先回到 `design.md` 校准：

| 文件 | 关键位置 | 检查方法 |
|---|---|---|
| `third/playwright/packages/playwright-core/src/tools/cli-client/program.ts` | `case 'show':` 在 204–270 | `sed -n '200,275p' third/playwright/.../program.ts` |
| `third/playwright/packages/playwright-core/src/tools/dashboard/dashboardApp.ts` | `openDashboardApp()` 在 276–325；`startDashboardServer` 在 50–116 | 同上 |
| `third/playwright/packages/playwright-core/src/tools/dashboard/dashboardController.ts` | `AttachedPage` 类在 371–524；`_startScreencast` 在 508–518 | 同上 |
| `third/playwright/packages/playwright-core/src/serverRegistry.ts` | `ServerRegistry` 类在 59–220；磁盘路径在 `_browsersDir()` 174–175（`registryDirectory` 常量在 255 行） | 同上 |
| `third/playwright/packages/playwright-core/src/tools/cli-client/registry.ts` | `baseDaemonDir` 常量 145–159；`Registry.load` 116–142 | 同上 |

漂移了就先修正 `design.md` 的引用，再实施。

### 0.2 确认 dashboard 入口可用

```bash
cd /home/alone/p/pi-web
node -e "console.log(require.resolve('playwright-core/lib/entry/dashboardApp.js'))"
```

如果解析失败，说明 `playwright-core` 没装（只有 `third/playwright/` 源码是不够的，需要在 `node_modules` 里）。处理方式：
- 看 `package.json` 里 `playwright` / `playwright-core` 是不是 devDependency。没有的话补上。
- 跑 `npm install`。
- 如果 `third/playwright-cli/playwright-cli` 已经能跑 `playwright-cli open`，那这个解析一般能过——因为 `playwright-cli.js` 里就是 `require('playwright-core/lib/tools/cli-client/program')`。

### 0.3 确认 daemon socket 和 registry 目录

```bash
ls -la "$HOME/.cache/ms-playwright/daemon" 2>/dev/null
ls -la "$HOME/.cache/ms-playwright/b" 2>/dev/null
```

两个目录可能都还没创建；只要手动起一次 `playwright-cli open`，它们就会出现。我们的代码要在首次访问时 `mkdir -p`，但要确认环境变量覆盖路径（`PWTEST_SERVER_REGISTRY`、`PWTEST_DAEMON_SESSION_DIR`、`PLAYWRIGHT_BROWSERS_PATH`）不会被现有 pi-web 代码改写——目前看 `lib/` 下没有相关代码，安全。

### 0.4 确认 pi-web 进程的用户态工具

- `node-pty` / `child_process` 可用（既有 `lib/npx.ts` 已经在 spawn 子进程，照抄它的写法）。
- `ws` 库可用：`grep -r "from 'ws'" /home/alone/p/pi-web/node_modules/playwright-core/lib/utilsBundle.js | head -3`（通常 vendor 了一份，但 Next.js 进程自己也可能要 `ws`，检查 `package.json`）。
- 如果没有 `ws`，加到 `dependencies`：`npm install ws @types/ws`。

---

## 1. 阶段 0——延迟验证（半天）

**目标**：跑通“iframe + 上游 dashboard”的最小回路，测出端到端帧延迟，作为后续阶段的基线。

**不做**：不写 pi-web 的集成代码。只写一个 Next.js route handler 起 dashboard，一个临时页面挂 iframe。

### 1.1 新增临时启动路由

**新建** `app/api/__poc/start-dashboard/route.ts`（注意目录前缀 `__poc` 是临时的，阶段 1 会替换为正式路径）：

```ts
import { spawn } from "child_process";
import { createLogger } from "@/lib/logger";
import { resolve } from "path";

const log = createLogger("api/__poc/start-dashboard");

export const dynamic = "force-dynamic";

export async function GET() {
  const dashboardEntry = require.resolve("playwright-core/lib/entry/dashboardApp.js");
  const port = 18181; // 固定端口方便调试
  const args = [
    dashboardEntry,
    `--workspaceDir=${process.cwd()}`,
    `--port=${port}`,
  ];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "inherit"],
    detached: false,
  });

  // 等到 "Dashboard is running pid=…" 出现在 stdout
  const ready = new Promise<number>((resolveP, rejectP) => {
    let buf = "";
    const timer = setTimeout(() => rejectP(new Error("timeout waiting for dashboard")), 10_000);
    child.stdout!.on("data", (data) => {
      buf += data.toString();
      const m = buf.match(/Dashboard is running pid=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolveP(Number(m[1]));
      }
    });
    child.on("exit", (code) => rejectP(new Error(`dashboard exited code=${code}\n${buf}`)));
  });

  const pid = await ready;
  log.info("dashboard started", { pid, port });
  return Response.json({ pid, port, url: `http://127.0.0.1:${port}` });
}
```

### 1.2 新增临时页面

**新建** `app/__poc/browser/page.tsx`：

```tsx
"use client";
import { useEffect, useState } from "react";

export default function BrowserPocPage() {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/__poc/start-dashboard")
      .then((r) => r.json())
      .then((d) => setUrl(d.url))
      .catch((e) => console.error(e));
  }, []);

  if (!url) return <div style={{ padding: 24 }}>starting dashboard…</div>;
  return (
    <iframe
      src={url}
      style={{ width: "100vw", height: "100vh", border: 0 }}
      allow="clipboard-read; clipboard-write"
    />
  );
}
```

### 1.3 验收

1. 在另一个终端跑：`playwright-cli open https://playwright.dev`（让 daemon 起来）。
2. `playwright-cli click e15`（找一个 ref；先 `playwright-cli snapshot`）。
3. 浏览器打开 `http://localhost:30141/__poc/browser`，应能看到 dashboard 列出 session 并实时显示 click 后的页面。
4. 在浏览器 DevTools 里观察 WS 帧：在 iframe 同源的 main 页面里跑：
   ```js
   const ws = new WebSocket("ws://127.0.0.1:18181/<guid-from-iframe-url>");
   ws.onmessage = (e) => {
     const msg = JSON.parse(e.data);
     if (msg.method === "frame") {
       performance.measure("frame", { detail: msg.params });
       console.log("frame at", performance.now(), "bytes:", msg.params.data.length);
     }
   };
   ```
   在 dashboard 主页加载完后从 URL 里抠出 GUID（`?ws=…`）。
5. 在 Network 面板观察 `data:` URL 的 img 请求频率——应该跟随 Chrome 的合成节奏（30–60 fps）。
6. **基线记录**：把 `console.log` 输出的延迟数截图保存，作为阶段 1 的对比基准。

### 1.4 清理

阶段 0 完成后**保留** `app/__poc/` 和 `app/api/__poc/`，方便阶段 1 复用。但不要在阶段 2 之后还留这两个目录——迁移到正式路径时一起删。

---

## 2. 阶段 1——最小集成（1 天）

**目标**：在 pi-web 里以正式路径起 dashboard、挂 iframe、加 WS 反代和静态资源反代。能用一个固定 session 工作。

### 2.1 新建 `lib/browser-view/types.ts`

把设计文档 §5.2 列出的类型集中在这里。**完整代码**：

```ts
// 与 third/playwright/packages/playwright-core/src/serverRegistry.ts 保持结构一致
export type BrowserDescriptor = {
  title: string;
  endpoint?: string;
  workspaceDir?: string;
  metadata?: Record<string, unknown>;
  playwrightVersion: string;
  playwrightLib: string;
  browser: {
    guid: string;
    browserName: "chromium" | "firefox" | "webkit";
    userDataDir?: string;
    launchOptions: Record<string, unknown>;
  };
};

export type BrowserViewSession = {
  // pi session id
  sessionId: string;
  // workspace dir of the pi session (process cwd of the agent when session was opened)
  workspaceDir: string | null;
  // playwright session names that have a running browser in this workspace
  playwrightNames: string[];
  // description for UI
  cwd: string;
};

export type DashboardInstance = {
  pid: number;
  port: number;
  url: string;            // http://127.0.0.1:<port>
  wsGuid: string;         // from the SPA's ?ws= query param
  startedAt: number;
};

export type RevealRequest = {
  sessionName: string;
  workspaceDir?: string;
};
```

> ⚠️ 不要从 `playwright-core` 直接 `import` `BrowserDescriptor`。一是 Next.js 的 server bundle 不喜欢 `playwright-core` 那个庞大的依赖图；二是上游的 export 路径可能变。本地复刻类型更稳。

### 2.2 新建 `lib/browser-view/dashboardLauncher.ts`

**职责**：管理一个独立的 dashboard 子进程（全局只有一个），暴露 `startIfNeeded() / sendReveal(req) / stop()`。

**完整代码**：

```ts
import { spawn, ChildProcessByStdio } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { Readable } from "stream";
import { createLogger } from "@/lib/logger";
import type { DashboardInstance, RevealRequest } from "./types";

const log = createLogger("browser-view/launcher");

// 在用户目录下持久化 pid+port，防止 Next.js 热重载后失忆
const STATE_FILE = path.join(os.homedir(), ".pi-web", ".dashboard.json");

// 上游 dashboard 用的 unix-socket 路径（见 dashboardApp.ts:211 dashboardSocketPath）
// 它读 makeSocketPath('dashboard', 'app') 的实际路径。
// 这里直接照抄上游的 makeSocketPath 行为（utils/fileUtils.ts）。
function dashboardSocketPath(): string {
  const base =
    process.platform === "win32"
      ? path.join("\\\\.\\pipe", "playwright", "dashboard-app")
      : path.join(os.tmpdir(), "playwright", "dashboard-app.sock");
  return base;
}

type DashboardState = { pid: number; port: number; wsGuid: string; url: string };

class DashboardLauncher {
  private _instance: DashboardInstance | null = null;
  private _child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  async startIfNeeded(): Promise<DashboardInstance> {
    if (this._instance) return this._instance;

    // 1. 尝试复用：检查 STATE_FILE 记录的 pid 是否还活着、端口是否能连
    const restored = await this._tryRestore();
    if (restored) {
      this._instance = restored;
      return restored;
    }

    // 2. 启动新的 dashboard 子进程
    const entry = require.resolve("playwright-core/lib/entry/dashboardApp.js");
    const port = await this._pickFreePort();
    const args = [
      entry,
      `--workspaceDir=${process.cwd()}`,
      `--port=${port}`,
    ];
    log.info("starting dashboard", { entry, port });

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "inherit"],
      detached: false,
    }) as ChildProcessByStdio<null, Readable, Readable>;
    this._child = child;

    const pid = await this._waitReady(child);
    // dashboard 启动后我们还不知道 wsGuid——它由 dashboard 内部生成。
    // 但是 SPA 会在 ?ws= 里把它告诉我们，所以我们需要先 GET 一次根路径，捕获 302。
    const wsGuid = await this._fetchWsGuid(port);
    const url = `http://127.0.0.1:${port}`;

    const inst: DashboardInstance = { pid, port, wsGuid, url, startedAt: Date.now() };
    this._instance = inst;
    await this._persist({ pid, port, wsGuid, url });
    return inst;
  }

  async sendReveal(req: RevealRequest): Promise<void> {
    // 通过 unix-socket 发一行 JSON（上游 dashboardApp.ts:256 client.write(... \n)）
    const sockPath = dashboardSocketPath();
    return new Promise((resolveP, rejectP) => {
      const sock = net.createConnection(sockPath);
      const timer = setTimeout(() => {
        sock.destroy();
        rejectP(new Error("reveal timeout"));
      }, 5_000);
      sock.on("connect", () => {
        sock.write(JSON.stringify(req) + "\n");
      });
      sock.on("data", () => { /* swallow */ });
      sock.on("end", () => {
        clearTimeout(timer);
        resolveP();
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        // 上游 acquireSingleton 的设计是：socket 已存在但没人监听 → 已有 dashboard 在跑
        // 这种情况我们其实不需要发 reveal——dashboard 自己已经有状态。
        // 但如果 dashboard 不接受外部客户端连接，就退化为：直接返回 success，
        // 让用户在前端面板上点击 reveal 按钮重新触发。
        log.warn("reveal socket failed", { err: e.message });
        resolveP();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this._child && !this._instance) return;
    const sockPath = dashboardSocketPath();
    await new Promise<void>((resolveP) => {
      const sock = net.createConnection(sockPath);
      const timer = setTimeout(() => { sock.destroy(); resolveP(); }, 3_000);
      sock.on("connect", () => sock.write(JSON.stringify({ kill: true }) + "\n"));
      sock.on("end", () => { clearTimeout(timer); resolveP(); });
      sock.on("error", () => { clearTimeout(timer); resolveP(); });
    });
    if (this._child && !this._child.killed) {
      this._child.kill("SIGTERM");
    }
    this._child = null;
    this._instance = null;
    try { await fs.promises.unlink(STATE_FILE); } catch { /* noop */ }
  }

  instance(): DashboardInstance | null { return this._instance; }

  // ---------- 私有 ----------

  private async _tryRestore(): Promise<DashboardInstance | null> {
    let state: DashboardState | null = null;
    try {
      state = JSON.parse(await fs.promises.readFile(STATE_FILE, "utf-8"));
    } catch { return null; }
    if (!state?.pid || !state?.port) return null;

    // 检查进程是否还活着
    try { process.kill(state.pid, 0); } catch { return null; }

    // 检查端口是否能连
    const reachable = await new Promise<boolean>((resolveP) => {
      const sock = net.createConnection(state!.port, "127.0.0.1");
      const timer = setTimeout(() => { sock.destroy(); resolveP(false); }, 1_000);
      sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolveP(true); });
      sock.on("error", () => { clearTimeout(timer); resolveP(false); });
    });
    if (!reachable) return null;

    return { pid: state.pid, port: state.port, wsGuid: state.wsGuid, url: state.url, startedAt: 0 };
  }

  private _waitReady(child: ChildProcessByStdio<null, Readable, Readable>): Promise<number> {
    return new Promise((resolveP, rejectP) => {
      let buf = "";
      const timer = setTimeout(() => rejectP(new Error("dashboard startup timeout")), 15_000);
      child.stdout.on("data", (data) => {
        buf += data.toString();
        const m = buf.match(/Dashboard is running pid=(\d+)/);
        if (m) { clearTimeout(timer); resolveP(Number(m[1])); }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        rejectP(new Error(`dashboard exited code=${code}\n${buf}`));
      });
    });
  }

  private async _fetchWsGuid(port: number): Promise<string> {
    // 上游 dashboardApp.ts:72 routePath('/') → 302 → /index.html?ws=<guid>
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    const location = res.headers.get("location") || "";
    const m = location.match(/[?&]ws=([a-f0-9]+)/);
    if (!m) throw new Error(`could not extract wsGuid from ${location}`);
    return m[1];
  }

  private async _pickFreePort(): Promise<number> {
    return new Promise((resolveP, rejectP) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", rejectP);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (!addr || typeof addr === "string") { srv.close(); rejectP(new Error("no addr")); return; }
        const port = addr.port;
        srv.close(() => resolveP(port));
      });
    });
  }

  private async _persist(s: DashboardState): Promise<void> {
    await fs.promises.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
  }
}

// Next.js HMR 会让模块重新加载，所以挂到 globalThis 上
declare global {
  // eslint-disable-next-line no-var
  var __piWebDashboard: DashboardLauncher | undefined;
}

export const dashboardLauncher = globalThis.__piWebDashboard ?? (globalThis.__piWebDashboard = new DashboardLauncher());
```

**注意事项**：
- 必须用 `globalThis` 持有单例——和 `lib/rpc-manager.ts` 处理 AgentSession 单例是同一个原因（HMR 会丢 module-level state）。
- 端口冲突时一定要走 `_pickFreePort`，不要硬编码。
- `sendReveal` 的 socket 调用目前没有 ack 解析（上游 daemon 收到后不写回东西）；如果以后要拿 ack，看 `dashboardApp.ts:330-373` 那段。

### 2.3 新建 `lib/browser-view/browserRegistry.ts`

**职责**：监听 `~/.cache/ms-playwright/b/` 目录，提供当前可用的浏览器列表。

**完整代码**：

```ts
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import os from "os";
import { createLogger } from "@/lib/logger";
import type { BrowserDescriptor } from "./types";

const log = createLogger("browser-view/registry");

// 与上游 serverRegistry.ts:255 registryDirectory 常量一致
function browsersDir(): string {
  const env = process.env.PWTEST_SERVER_REGISTRY;
  if (env) return env;
  // windows / darwin / linux 三个分支；和上游 defaultCacheDirectory 一致
  const cache =
    process.platform === "linux"
      ? process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
      : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(cache, "ms-playwright", "b");
}

class BrowserRegistry extends EventEmitter {
  private _cache = new Map<string, BrowserDescriptor>();

  async refresh(): Promise<BrowserDescriptor[]> {
    const dir = browsersDir();
    let files: string[] = [];
    try { files = await fs.promises.readdir(dir); } catch { return []; }

    const next = new Map<string, BrowserDescriptor>();
    for (const f of files) {
      try {
        const content = await fs.promises.readFile(path.join(dir, f), "utf-8");
        const desc = JSON.parse(content) as BrowserDescriptor;
        if (desc.title?.startsWith("--playwright-internal")) continue; // 跟随上游 registrySessionProvider.ts:131
        next.set(desc.browser.guid, desc);
      } catch (e) {
        log.warn("failed to read browser descriptor", { file: f, err: String(e) });
      }
    }

    const added: BrowserDescriptor[] = [];
    const removed: string[] = [];
    for (const [guid, desc] of next) {
      if (!this._cache.has(guid)) added.push(desc);
    }
    for (const guid of this._cache.keys()) {
      if (!next.has(guid)) removed.push(guid);
    }
    this._cache = next;

    for (const desc of added) this.emit("added", desc);
    for (const guid of removed) this.emit("removed", guid);
    for (const desc of next.values()) this.emit("changed", desc);

    return [...next.values()];
  }

  list(): BrowserDescriptor[] { return [...this._cache.values()]; }
}

declare global {
  // eslint-disable-next-line no-var
  var __piWebBrowserRegistry: BrowserRegistry | undefined;
}

export const browserRegistry = globalThis.__piWebBrowserRegistry ?? (globalThis.__piWebBrowserRegistry = new BrowserRegistry());

// 可选：周期刷新（上游用 chokidar 监听；我们先做轮询，写起来更简单，后面再升级）
if (!globalThis.__piWebBrowserRegistryPoller) {
  (globalThis as any).__piWebBrowserRegistryPoller = setInterval(() => {
    browserRegistry.refresh().catch(() => {});
  }, 1_000);
  // unref 避免拖住进程退出
  (globalThis as any).__piWebBrowserRegistryPoller.unref?.();
}
```

**注意**：上游用 chokidar 做 inotify；我们先用 1 秒轮询，理由：
- pi-web 是 server，单进程，单线程，1 秒轮询读 1–10 个小 JSON 文件开销可忽略。
- 上游 dashboard 的 `_scheduleSessions()` 内部也是用 `queueMicrotask` 调度，没有追求实时——上游的“实时”实际上靠 chokidar 的回调，我们落后一秒人眼看不出来。
- 后续如果觉得不够再换 chokidar：`npm install chokidar @types/chokidar`。

### 2.4 新建 `lib/browser-view/sessionMap.ts`

**职责**：把 pi 的 session id 映射到 playwright 的 session name 列表。

```ts
import path from "path";
import os from "os";
import fs from "fs";
import { createLogger } from "@/lib/logger";
import { resolveSessionPath } from "@/lib/session-reader";
import type { BrowserViewSession } from "./types";

const log = createLogger("browser-view/session-map");

// 与上游 cli-client/registry.ts:145 baseDaemonDir 一致
function baseDaemonDir(): string {
  if (process.env.PWTEST_DAEMON_SESSION_DIR) return process.env.PWTEST_DAEMON_SESSION_DIR;
  const cache =
    process.platform === "linux"
      ? process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
      : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(cache, "ms-playwright", "daemon");
}

function workspaceHash(workspaceDir: string): string {
  // 与上游 cli-client/registry.ts:165-167 一致
  // crypto.createHash('sha1').update(workspaceDir || packageRoot).digest('hex').substring(0, 16)
  const crypto = require("crypto") as typeof import("crypto");
  return crypto.createHash("sha1").update(workspaceDir).digest("hex").substring(0, 16);
}

export async function listBrowserSessionsForPiSession(sessionId: string): Promise<BrowserViewSession> {
  const filePath = await resolveSessionPath(sessionId);
  // 从 .jsonl 头取 cwd（与 events/route.ts:27 同样做法）
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

  const dir = path.join(baseDaemonDir(), workspaceHash(cwd));
  let names: string[] = [];
  try {
    const files = await fs.promises.readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".session")) continue;
      try {
        const content = await fs.promises.readFile(path.join(dir, f), "utf-8");
        const cfg = JSON.parse(content);
        // 与上游 SessionConfig（registry.ts:38-53）一致；过滤出 cli-persistent 或 attached
        if (cfg.workspaceDir && cfg.workspaceDir !== cwd) continue;
        if (cfg.name) names.push(cfg.name);
      } catch { /* skip */ }
    }
  } catch { /* dir 不存在 */ }

  return { sessionId, workspaceDir: cwd, playwrightNames: names, cwd };
}
```

**注意**：`resolveSessionPath` 是 `lib/session-reader.ts` 已经导出的，照用。`SessionManager.open().getHeader()?.cwd` 模式来自 `events/route.ts:27`。

### 2.5 新建 `app/api/browser-view/sessions/route.ts`

```ts
import { listBrowserSessionsForPiSession } from "@/lib/browser-view/sessionMap";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("sessionId required", { status: 400 });
  const sessions = await listBrowserSessionsForPiSession(sessionId);
  return Response.json(sessions);
}
```

### 2.6 新建 `app/api/browser-view/reveal/route.ts`

```ts
import { dashboardLauncher } from "@/lib/browser-view/dashboardLauncher";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { sessionName, workspaceDir } = (await req.json()) as { sessionName: string; workspaceDir?: string };
  if (!sessionName) return new Response("sessionName required", { status: 400 });
  const inst = await dashboardLauncher.startIfNeeded();
  await dashboardLauncher.sendReveal({ sessionName, workspaceDir });
  return Response.json({
    iframeUrl: `/api/browser-view/proxy/?ws=${inst.wsGuid}`,
    wsPath: `/api/browser-view/ws/${inst.wsGuid}`,
    dashboardUrl: inst.url,
  });
}
```

### 2.7 新建 `app/api/browser-view/proxy/[...path]/route.ts`

```ts
import { dashboardLauncher } from "@/lib/browser-view/dashboardLauncher";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/browser-view/proxy");

export const dynamic = "force-dynamic";

// 透传 GET 请求到上游 dashboard。响应头原样复制。
export async function GET(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const inst = dashboardLauncher.instance();
  if (!inst) return new Response("dashboard not running", { status: 503 });

  const { path: pathParts = [] } = await params;
  const upstream = `${inst.url}/${pathParts.join("/")}${new URL(req.url).search}`;

  // fetch 默认会自动处理重定向。我们这里要 manual，因为上游的 / → /index.html?ws=… 必须保留给浏览器
  const upstreamRes = await fetch(upstream, {
    method: "GET",
    redirect: "manual",
    headers: { Accept: req.headers.get("accept") || "*/*" },
  });

  const headers = new Headers();
  // 只复制对前端有用的头；不复制 set-cookie、content-encoding（fetch 自动解压）
  for (const [k, v] of upstreamRes.headers) {
    if (["set-cookie", "content-encoding", "transfer-encoding"].includes(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  // 注入 frame-ancestors，让 iframe 可以嵌
  headers.set("content-security-policy", "frame-ancestors 'self'");

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
}
```

**注意**：
- `redirect: "manual"` 至关重要——上游的 `dashboardApp.ts:72-77` 是个 302，我们把它原样透传回去，不能让 fetch 跟过去。
- 静态资源 SPA 用 vite 打包；资源路径下还有 `/assets/*.js`、`/assets/*.css`，都要走这个路由——Next.js 的 `[...path]` catch-all 会兜住。

### 2.8 新建 `app/api/browser-view/ws/[guid]/route.ts`

```ts
import { dashboardLauncher } from "@/lib/browser-view/dashboardLauncher";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

// Next.js App Router 不直接暴露 upgrade，但 App Router 的 dev server (Node http.Server)
// 会被 ws 库通过 noServer 模式接管。我们挂一个 hint 到 globalThis，dev/start 入口处复用。
declare global {
  // eslint-disable-next-line no-var
  var __piWebBrowserViewWss: WebSocketServer | undefined;
  // eslint-disable-next-line no-var
  var __piWebHttpServer: import("http").Server | undefined;
}

function ensureWss(): WebSocketServer {
  if (globalThis.__piWebBrowserViewWss) return globalThis.__piWebBrowserViewWss;
  const wss = new WebSocketServer({ noServer: true });
  globalThis.__piWebBrowserViewWss = wss;
  return wss;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ guid: string }> }) {
  const { guid } = await params;
  const inst = dashboardLauncher.instance();
  if (!inst) return new Response("dashboard not running", { status: 503 });

  // 把 Next.js 的 WebSocket upgrade 透传到上游 dashboard 的 ws://
  // Next.js App Router 默认不暴露底层 http.Server。我们需要从 globalThis 拿到它。
  // 见 §2.8.1：注册钩子。
  const upstreamUrl = `${inst.url.replace(/^http/, "ws")}/${guid}`;

  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  // 用 response body 的方式不够——WebSocket upgrade 必须在底层 http.Server 上拦截。
  // 这里返回 426 是兜底；真正的 WS upgrade 在 §2.8.1 注册的钩子里处理。
  // 下面的代码在主路径上不会执行（因为 Next.js 会拦截 upgrade）。
  return new Response("expected websocket upgrade", { status: 426 });
}
```

**2.8.1 关键补充：WS upgrade 钩子**

Next.js 16 的 App Router **不会**让你从 route handler 内部直接拦截 WebSocket upgrade。需要：

- **方案 A（推荐）**：在 `instrumentation.ts`（仓库根已有 `instrumentation.ts`）里挂一个全局钩子：
  ```ts
  export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { WebSocketServer } = await import("ws");
    const { dashboardLauncher } = await import("@/lib/browser-view/dashboardLauncher");
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (clientWs, request) => {
      const m = request.url?.match(/^\/api\/browser-view\/ws\/([a-f0-9]+)/);
      if (!m) { clientWs.close(); return; }
      const guid = m[1];
      const inst = dashboardLauncher.instance();
      if (!inst) { clientWs.close(); return; }
      const upstream = new (require("ws"))(`${inst.url.replace(/^http/, "ws")}/${guid}`);
      upstream.on("open", () => {
        clientWs.on("message", (data, isBinary) => upstream.send(data, { binary: isBinary }));
        upstream.on("message", (data, isBinary) => clientWs.send(data, { binary: isBinary }));
        clientWs.on("close", () => upstream.close());
        upstream.on("close", () => clientWs.close());
        clientWs.on("error", () => upstream.close());
        upstream.on("error", () => clientWs.close());
      });
      upstream.on("error", () => clientWs.close());
    });

    // Next.js 把 http.Server 通过这个钩子暴露给 instrumentation
    // 文档：https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
    // 我们把 ws 升级逻辑挂到 globalThis.__nextHttpServer 上。
    // 真实集成需要看 Next.js 当前版本的 API；如果不稳定，先用一个独立的 Node 进程
    // 跑 WS 反代，由 Next.js 反向代理到那个进程（见方案 B）。
  }
  ```

- **方案 B（兜底，独立进程）**：写一个 30 行的小 Node 脚本 `scripts/browser-view-ws-proxy.ts`，独立跑：
  ```ts
  import { WebSocketServer } from "ws";
  const wss = new WebSocketServer({ port: 30142 });
  wss.on("connection", (clientWs, req) => {
    const m = req.url?.match(/^\/([a-f0-9]+)/);
    if (!m) { clientWs.close(); return; }
    const upstream = new WebSocket(`ws://127.0.0.1:18181/${m[1]}`);
    upstream.on("open", () => {
      clientWs.on("message", (d, b) => upstream.send(d, { binary: b }));
      upstream.on("message", (d, b) => clientWs.send(d, { binary: b }));
      clientWs.on("close", () => upstream.close());
      upstream.on("close", () => clientWs.close());
    });
    upstream.on("error", () => clientWs.close());
  });
  ```
  然后让 iframe 里的 SPA 直接连 `ws://localhost:30142/<guid>`，跨端口同主机——浏览器允许。

**实施建议**：阶段 1 先用**方案 B**，跑通端到端后再尝试方案 A。方案 A 涉及到 Next.js 私有 API 的兼容性，最坏情况可能要走 next.config.ts 的 custom server（但那会失去 App Router 的一些特性）。

### 2.9 新增 `components/BrowserView/BrowserViewTab.tsx`

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useToast } from "@/components/Toast";

export function BrowserViewTab({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revealLockRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. 拿可用 session 列表
        const sessRes = await fetch(`/api/browser-view/sessions?sessionId=${encodeURIComponent(sessionId)}`);
        if (!sessRes.ok) throw new Error(`sessions: ${sessRes.status}`);
        const sess = await sessRes.json();
        const firstName = sess.playwrightNames?.[0];
        if (!firstName) {
          setError(t("NoActiveBrowser"));
          return;
        }

        // 2. 调 reveal（后端会拉起 dashboard 并返回 iframe URL）
        if (revealLockRef.current) return;
        revealLockRef.current = true;
        const revealRes = await fetch("/api/browser-view/reveal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionName: firstName, workspaceDir: sess.workspaceDir ?? undefined }),
        });
        if (!revealRes.ok) throw new Error(`reveal: ${revealRes.status}`);
        const data = await revealRes.json();
        if (cancelled) return;
        setIframeUrl(data.iframeUrl);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        toast.show({ kind: "error", message: msg });
      } finally {
        revealLockRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, toast, t]);

  if (error) return <div style={{ padding: 24, color: "var(--text-muted)" }}>{error}</div>;
  if (!iframeUrl) return <div style={{ padding: 24 }}>{t("LaunchDashboard")}</div>;

  return (
    <iframe
      src={iframeUrl}
      style={{ width: "100%", height: "100%", border: 0, background: "var(--bg)" }}
      allow="clipboard-read; clipboard-write"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      referrerPolicy="no-referrer"
    />
  );
}
```

**注意 `sandbox`**：上游 dashboard SPA 用 `eval()` 处理路由 hash（看 vite bundle），所以不能禁掉 `allow-scripts` 和 `allow-same-origin`。CSP 由上游 dashboard 自己产出，我们已经在 `proxy/route.ts` 里注入了 `frame-ancestors`。

### 2.10 修改 `components/TabBar.tsx`

把联合类型扩展：

```diff
 export type Tab =
   | { kind: "file"; id: string; label: string; filePath: string }
-  | { kind: "todo"; id: string; label: string };
+  | { kind: "todo"; id: string; label: string }
+  | { kind: "browser"; id: string; label: string };
```

图标：复用浏览器图标（在 `components/FileIcons.tsx` 里挑一个 SVG，或者从 `lobehub/icons` 拿 `BiLogoChrome`）。

### 2.11 修改 `components/AppShell.tsx`

找到 tab 管理逻辑（grep `kind: "todo"`），加一个 case：

```tsx
{tab.kind === "browser" && <BrowserViewTab sessionId={activeSessionId} />}
```

具体位置：`AppShell.tsx` 渲染 `activeTabId` 对应内容的 switch 里。

### 2.12 修改 `hooks/useI18n.tsx`

按设计文档 §6.5 的清单加键：
- `BrowserView`、`Reveal`、`LaunchDashboard`、`BrowserSession`、`Quality`、`NoActiveBrowser`、`BrowserDisconnected`、`DashboardKilled`、`Reconnected`

每个键在 `ZH_TRANSLATIONS` 加中文翻译。

### 2.13 验收

1. `npm run dev`
2. 浏览器打开 pi-web，随便选一个 pi session
3. 另起终端：`playwright-cli open https://playwright.dev` 然后 `playwright-cli click e15`
4. 在 pi-web 切到 browser tab：应能看到 dashboard 渲染并在 click 后画面更新
5. WS 帧频率与阶段 0 的基线对比；延迟增加应在 5 ms 以内（仅多一次本地 TCP 跳）

### 2.14 清理

阶段 1 通过后**保留** `app/__poc/`（用于人工冒烟测试）。后续阶段可以删掉。

---

## 3. 阶段 2——多 session 选择器（半天）

**目标**：在 `BrowserViewPanel` 里加一个下拉，让用户在多个 playwright session 之间切换。

### 3.1 新建 `components/BrowserView/BrowserViewPanel.tsx`

```tsx
"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

type SessionInfo = {
  sessionId: string;
  workspaceDir: string | null;
  playwrightNames: string[];
  cwd: string;
};

export function BrowserViewPanel({
  sessionId,
  onSelect,
}: {
  sessionId: string;
  onSelect: (playwrightName: string, workspaceDir: string | null) => void;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/browser-view/sessions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d: SessionInfo) => {
        if (cancelled) return;
        setInfo(d);
        setSelected(d.playwrightNames?.[0] ?? "");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  if (!info) return null;
  if (info.playwrightNames.length === 0) {
    return <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 12 }}>
      {t("NoActiveBrowser")}
    </div>;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
      <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("BrowserSession")}</label>
      <select
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          onSelect(e.target.value, info.workspaceDir);
        }}
        style={{ fontSize: 12, padding: "2px 6px", background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 3 }}
      >
        {info.playwrightNames.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <a
        href={`/api/browser-view/reveal?sessionName=${encodeURIComponent(selected)}&workspaceDir=${encodeURIComponent(info.workspaceDir ?? "")`}
        target="_blank"
        rel="noreferrer"
        style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}
      >
        {t("OpenInNewWindow")} ↗
      </a>
    </div>
  );
}
```

### 3.2 把 `BrowserViewTab` 改成组装两者

```tsx
export function BrowserViewTab({ sessionId }: { sessionId: string }) {
  const [reveal, setReveal] = useState<{ iframeUrl: string } | null>(null);
  // ... fetch reveal effect ...
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <BrowserViewPanel
        sessionId={sessionId}
        onSelect={async (name, wsDir) => {
          const r = await fetch("/api/browser-view/reveal", { method: "POST", body: JSON.stringify({ sessionName: name, workspaceDir: wsDir }) });
          const d = await r.json();
          setReveal(d);
        }}
      />
      <div style={{ flex: 1 }}>
        {reveal && <iframe src={reveal.iframeUrl} ... />}
      </div>
    </div>
  );
}
```

### 3.3 i18n + toast

新增 `OpenInNewWindow`、`SessionListChanged`、`DashboardKilled`、`Reconnected` 键。Reveal 成功 toast：`t("Reveal") + " " + sessionName`。

### 3.4 验收

1. 起两个 daemon：`playwright-cli -s=foo open` 和 `playwright-cli -s=bar open`
2. 在下拉里切换，应能看到 dashboard 跟着切换到对应 session 的页面

---

## 4. 阶段 3——与 agent 工具调用关联（半天，可选）

**目标**：在 iframe 上面叠加一行高亮，显示当前 agent 正在执行的 playwright-cli 子命令。

### 4.1 新建 `hooks/useBrowserViewOverlay.ts`

```tsx
import { useEffect, useState } from "react";

type OverlayItem = { id: string; label: string; at: number };

export function useBrowserViewOverlay(sessionId: string): OverlayItem | null {
  const [active, setActive] = useState<OverlayItem | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/agent/${sessionId}/events`);
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        // 看 lib/types.ts 里 toolCall 的结构（type: "toolCall", toolName）
        if (evt.type === "toolCall" && typeof evt.toolName === "string" && evt.toolName.startsWith("playwright-cli")) {
          setActive({ id: evt.toolCallId, label: evt.toolName, at: Date.now() });
          // 1.5s 后清掉，让下一个事件盖上去
          setTimeout(() => {
            setActive((cur) => (cur && cur.id === evt.toolCallId ? null : cur));
          }, 1500);
        }
      } catch { /* noop */ }
    };
    return () => es.close();
  }, [sessionId]);

  return active;
}
```

### 4.2 在 `BrowserViewTab` 顶部加一个覆盖层

```tsx
const overlay = useBrowserViewOverlay(sessionId);
return (
  <div style={{ position: "relative", height: "100%" }}>
    {overlay && (
      <div style={{
        position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
        padding: "4px 12px", background: "rgba(0,0,0,0.7)", color: "white",
        borderRadius: 4, fontSize: 12, zIndex: 10,
      }}>
        {overlay.label}
      </div>
    )}
    <iframe src={iframeUrl} style={{ width: "100%", height: "100%", border: 0 }} />
  </div>
);
```

### 4.3 验证工具调用名的对齐

实际 agent 调用 playwright 时，`toolName` 到底是什么？看 `third/pi/packages/coding-agent/` 里的 tool 注册机制，再 grep 一下既有 session 文件里出现过的 toolCall：

```bash
grep -r "toolName.*playwright" /home/alone/.pi/agent/sessions | head -5
```

如果工具名不是 `playwright-cli` 开头，改 `useBrowserViewOverlay` 的判断条件。

---

## 5. 阶段 4——降级轮询模式（半天，可选）

**目标**：当上游 `dashboardApp.js` 不可用时（精简安装），pi-web 仍然能给出一个低质量但能用的画面。

### 5.1 新建 `lib/browser-view/pollingFallback.ts`

```ts
import { createRequire } from "module";
import type { ServerResponse } from "http";
import { createLogger } from "@/lib/logger";

const log = createLogger("browser-view/polling");

let playwrightPromise: Promise<any> | null = null;
async function loadPlaywright() {
  if (!playwrightPromise) {
    playwrightPromise = import("playwright-core").catch(() => null);
  }
  return playwrightPromise;
}

export async function streamPollingFrames(
  pipePath: string,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const pw = await loadPlaywright();
  if (!pw) {
    res.statusCode = 503;
    res.end("playwright-core not available");
    return;
  }
  const browser = await pw.chromium.connect(pipePath);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (!page) {
    res.statusCode = 404;
    res.end("no page");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let stopped = false;
  signal.addEventListener("abort", () => { stopped = true; });

  // 4 fps
  const interval = 250;
  while (!stopped) {
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 70 });
      res.write(`event: frame\ndata: ${buf.toString("base64")}\n\n`);
    } catch (e) {
      log.warn("screenshot failed", { err: String(e) });
      res.write(`event: error\ndata: ${String(e)}\n\n`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  res.end();
}
```

### 5.2 新建 `app/api/browser-view/polling/[sessionName]/route.ts`

```ts
import { streamPollingFrames } from "@/lib/browser-view/pollingFallback";
import { dashboardLauncher } from "@/lib/browser-view/dashboardLauncher";
import fs from "fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ sessionName: string }> }) {
  const { sessionName } = await params;
  // 上游 daemon 的 session socket 路径：~/.cache/ms-playwright/daemon/<hash>-<name>
  // 我们需要从 sessionName 倒推 hash。最简单的做法：让前端带过来。
  const url = new URL(_req.url);
  const hash = url.searchParams.get("hash");
  const pipePath = `\\\\.\\pipe\\playwright\\cli-${hash}-${sessionName}`; // 简化处理；windows 上游用 named pipe
  // 实际上 unix 是 path.join(baseDaemonDir, hash, `${sessionName}.session` 的 socketPath 字段)
  // 复杂，留给实施者去读 cli-daemon/daemon.ts:151 daemonSocketPath
  // TODO：读 session.json 取 socketPath

  const stream = new ReadableStream({
    start(controller) {
      const fakeRes = {
        statusCode: 200,
        setHeader: () => {},
        flushHeaders: () => {},
        write: (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk)),
        end: () => controller.close(),
      } as any;
      streamPollingFrames(pipePath, fakeRes, _req.signal);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}
```

> 这一阶段比较琐碎。polling path 本身可以延后做，**优先级最低**。

---

## 6. 测试与验证策略

### 6.1 单元测试

- `lib/browser-view/dashboardLauncher.ts`：用 mock `child_process.spawn` 验证 stdout 解析、`_tryRestore` 行为。
- `lib/browser-view/sessionMap.ts`：固定一个 fixture（`~/.cache/ms-playwright/daemon/<hash>/foo.session`），验证过滤和映射。
- `lib/browser-view/browserRegistry.ts`：临时目录里塞几个 JSON，验证 `refresh()` 行为。

### 6.2 端到端测试（人工）

按阶段顺序手动跑：

| 阶段 | 验收命令 |
|---|---|
| 0 | 见 §1.3 |
| 1 | 见 §2.13 |
| 2 | 见 §3.4 |
| 3 | 见 §4.3 |
| 4 | 故意删 `playwright-core/lib/entry/dashboardApp.js`（或者 `npm uninstall playwright`），降级路径应能 work |

### 6.3 回归测试

- 阶段 1 完成后**必须**：`npm run lint` 通过、`tsc --noEmit` 通过。
- 不允许破坏现有 SSE / agent events 的工作方式。

### 6.4 性能基线

阶段 0 测得的延迟记在 `docs/browser-view/baseline.md`（新建一个），阶段 1/2 完成时再测一次。每次升级（优化 JS bundle、改反代实现等）都对比一次。

---

## 7. 文件清单总览

### 新建（按依赖顺序）

```
lib/browser-view/types.ts
lib/browser-view/dashboardLauncher.ts
lib/browser-view/browserRegistry.ts
lib/browser-view/sessionMap.ts
app/api/browser-view/sessions/route.ts
app/api/browser-view/reveal/route.ts
app/api/browser-view/proxy/[...path]/route.ts
app/api/browser-view/ws/[guid]/route.ts        (WS 升级钩子放 instrumentation.ts)
lib/browser-view/pollingFallback.ts            (阶段 4)
app/api/browser-view/polling/[sessionName]/route.ts  (阶段 4)
components/BrowserView/BrowserViewTab.tsx
components/BrowserView/BrowserViewPanel.tsx
hooks/useBrowserViewOverlay.ts                  (阶段 3)
app/__poc/browser/page.tsx                      (阶段 0 POC，可后删)
app/api/__poc/start-dashboard/route.ts          (阶段 0 POC，可后删)
docs/browser-view/baseline.md                   (阶段 0 测得的延迟基线)
```

### 修改

```
components/TabBar.tsx                           Tab 联合 + 浏览器图标
components/AppShell.tsx                         browser tab 渲染分支
hooks/useI18n.tsx                               6–10 个 i18n 键
instrumentation.ts                              WS 升级钩子（阶段 1，如果走方案 A）
```

### 不动

```
third/playwright*           上游源代码
package.json                除非阶段 4 需要加 `playwright-core`（一般已经有了）
```

---

## 8. 已知陷阱与“下次踩坑前必读”

### 8.1 Next.js HMR 会清空 module-level 单例

`dashboardLauncher` 和 `browserRegistry` 都挂在 `globalThis` 上，原因和 `lib/rpc-manager.ts` 处理 AgentSession 完全一样。看 `CLAUDE.md` §"AgentSession lifecycle"。

### 8.2 上游 `dashboardApp.js` 的 stdout 可能含 ANSI 控制字符

`Listening on http://…` 行可能有 ANSI。看 `dashboardApp.ts:294` 后面那段。

匹配 `/Dashboard is running pid=(\d+)/` 时不需要去 ANSI；用 `String.prototype.match` 就能透过去。但 `[32m` 这种会出现在 buf 里，**不会**破坏正则。

### 8.3 上游 `/api/browser-view/proxy/?ws=…` 必须保留 302

如果 fetch 默认 follow redirect，iframe 的 URL 就变成 `/index.html?ws=…`，wsGuid 仍然在 query 里——看起来没问题。但 SPA 会做相对路径的 WS 构造（看 `dashboard/src/transport.ts:29`），所以同源才是关键。**务必 `redirect: "manual"`**。

### 8.4 Chromium 的 screencast 会“冻结”于后台标签

当浏览器 tab 不在 foreground，Chrome 节流到 1 fps。这是浏览器行为，不是我们的 bug。用户在 pi-web 里切到别的 tab 时画面会变卡；这是预期的。

### 8.5 两个 dashboard 抢一个 daemon

如果用户手动跑了 `playwright-cli show`（带 GUI），同时又在 pi-web 里打开 browser tab——我们的 `_tryRestore` 会检测到端口被占，启动失败。

处理：检测 `EADDRINUSE`，改成“连已有 dashboard 的端口，从它的 `/` 抓 wsGuid，复用”——这部分逻辑可以放在阶段 2 之后追加，先按“dashboard 启动失败 → 报错给用户”跑。

### 8.6 Playwright 的 session 可能和 pi session 不同生命周期

daemon session 在用户关掉浏览器 tab 后可能保留几秒；agent session 持续几小时。两者不绑定。所以下拉里看不到任何 playwright name 是正常的——这意味着用户没在那个 workspace 里起过浏览器。

### 8.7 CSP `frame-ancestors`

上游 dashboard 不会发 `Content-Security-Policy: frame-ancestors 'self'`，所以现代浏览器默认拒绝跨源 iframe。我们在 `proxy/route.ts` 里手动注入；如果以后上游自己加了，记得去重。

### 8.8 静态资源路径大小写

vite 打包出来的资源路径在不同 OS 上大小写敏感性不同。代理的时候保留原样，不要做 `path.normalize`。

---

## 9. 与上游的同步策略

每个 pi-web release 前，**重跑 §0.1 的行号检查**。如果漂移：
- 90% 的情况只是行号变了——更新 `design.md` 里的引用即可。
- 9% 的情况上游改了字段名（比如 `BrowserDescriptor` 多了字段）——更新 `lib/browser-view/types.ts`。
- 1% 的情况上游重写了 dashboard——回到本文档 §4 重新评估三个候选方案；通常 iframe 嵌入仍然可行，但可能要适配 SPA 入口的查询参数。

订阅上游变更：watch `microsoft/playwright` repo 的 releases；每个 minor 版本（`v1.6X`）跑一次冒烟。

---

## 10. 移交检查清单

下一个接手的人应该按顺序确认以下 12 项全部 ✅：

- [ ] §0.1：上游文件行号检查无漂移
- [ ] §0.2：`playwright-core/lib/entry/dashboardApp.js` 可解析
- [ ] §0.3：缓存目录存在
- [ ] §1.3：阶段 0 POC iframe 能看到 dashboard
- [ ] §2.13：阶段 1 iframe + WS 反代跑通
- [ ] §3.4：阶段 2 多 session 切换跑通
- [ ] `npm run lint` 通过
- [ ] `node_modules/.bin/tsc --noEmit` 通过
- [ ] `docs/browser-view/baseline.md` 写好延迟基线
- [ ] 没有引入 `third/playwright*` 的修改
- [ ] `useI18n.tsx` 的新键都加了中英文
- [ ] `Toast` 在 reveal/kill/reconnect 三个时刻都触发了

完成所有 12 项后，本次任务可以视为交付。