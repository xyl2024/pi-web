# Playwright Dashboard 集成 — 最小 MVP 实施计划

> 对应设计文档：`docs/playwright-dashboard/design.md`
> 目标：4 个文件、~150 行净增，跑起来后侧边栏底部多一个可折叠的 Playwright Dashboard 面板。

---

## 总览

| 步骤 | 文件 | 类型 | 验证 |
|---|---|---|---|
| 1 | `lib/playwright-dashboard.ts` | 新增 | 启动子进程，pid 存活，端口可访问 |
| 2 | `app/api/dashboard/status/route.ts` | 新增 | `curl /api/dashboard/status` 返回 `{ url, ready, pid }` |
| 3 | `components/PlaywrightDashboardPanel.tsx` | 新增 | 折叠/展开切换，iframe 加载并显示 Dashboard |
| 4 | `components/AppShell.tsx` | 编辑 ~10 行 | 侧边栏底部出现面板 |
| 5 | `hooks/useI18n.tsx` | 编辑 | zh/en 文案补齐 |
| 6 | 端到端验证 | — | agent 用 playwright-cli 开浏览器，侧边栏能看到 |

---

## 步骤 1：`lib/playwright-dashboard.ts`（新增）

**职责**：模块级 singleton，spawn `playwright-cli show`，管理生命周期，暴露 URL。

**关键约束**：
- 必须用 `globalThis` 缓存 spawn 状态，避开 Next.js dev hot-reload 重置模块作用域（参考 `lib/rpc-manager.ts` 的 `__piSessions` 模式）
- 端口选择：`PI_WEB_DASHBOARD_PORT` env var（默认 4321），被占用则向后顺延 4322, 4323...直到找到空闲端口
- 启动探测：spawn 后轮询 `GET http://127.0.0.1:<port>/index.html`，10 秒内拿到 200 算 ready，否则标记 failed
- 子进程 detached + stdio ignore + unref，不污染 Node 进程树
- SIGTERM/SIGINT 钩子：终止子进程

**骨架（不写完整实现，先对齐结构）**：

```typescript
// lib/playwright-dashboard.ts
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import { logger } from "./logger";

const DEFAULT_PORT = 4321;
const PROBE_TIMEOUT_MS = 10_000;

interface DashboardState {
  child: ChildProcess | null;
  url: string | null;
  port: number | null;
  pid: number | null;
  ready: Promise<boolean>;
  lastError: string | null;
}

const KEY = "__piWebDashboard";
type GlobalScope = typeof globalThis & { [KEY]?: DashboardState };

function getState(): DashboardState {
  const g = globalThis as GlobalScope;
  if (!g[KEY]) {
    g[KEY] = {
      child: null, url: null, port: null, pid: null,
      ready: Promise.resolve(false), lastError: null,
    };
  }
  return g[KEY];
}

async function probeReady(port: number): Promise<boolean> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/index.html", timeout: 1000 }, (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function pickPort(preferred: number): Promise<number> {
  // TODO: try preferred, then preferred+1, +2, ... up to +9
  return preferred; // MVP 先简化
}

export async function startDashboard(): Promise<void> {
  const state = getState();
  if (state.child) return; // already started
  state.ready = (async () => {
    const port = await pickPort(Number(process.env.PI_WEB_DASHBOARD_PORT) || DEFAULT_PORT);
    const child = spawn("playwright-cli", [
      "show",
      "--host=127.0.0.1",
      `--port=${port}`,
    ], { detached: true, stdio: "ignore" });
    child.unref();
    state.child = child;
    state.port = port;
    state.pid = child.pid ?? null;
    const ok = await probeReady(port);
    if (!ok) {
      state.lastError = "Dashboard failed to start within timeout";
      logger.warn({ port, pid: child.pid }, "playwright dashboard not ready");
      return false;
    }
    state.url = `http://127.0.0.1:${port}/`;
    logger.info({ url: state.url, pid: child.pid }, "playwright dashboard ready");
    return true;
  })();
}

export function getDashboardUrl(): string | null {
  return getState().url;
}

export async function getDashboardStatus(): Promise<{ url: string | null; ready: boolean; pid: number | null; error: string | null }> {
  let s = getState();
  if (!s.child) {
    // lazy start
    void startDashboard();
    s = getState();
  }
  const ready = await s.ready;
  return { url: s.url, ready, pid: s.pid, error: s.lastError };
}

export function stopDashboard(): void {
  const s = getState();
  if (s.child && s.pid) {
    try { process.kill(s.pid, "SIGTERM"); } catch { /* already dead */ }
  }
  s.child = null;
  s.url = null;
}

// 进程退出时清理
let cleanupRegistered = false;
export function ensureCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("SIGTERM", stopDashboard);
  process.once("SIGINT", stopDashboard);
}
```

**验证**：
- `node -e 'require("./lib/playwright-dashboard").startDashboard().then(()=>console.log(require("./lib/playwright-dashboard").getDashboardUrl()))'` 
- 期望输出 `http://127.0.0.1:4321/`
- `curl http://127.0.0.1:4321/index.html` 返回 200 + HTML

---

## 步骤 2：`app/api/dashboard/status/route.ts`（新增）

**职责**：暴露 `GET /api/dashboard/status`，前端轮询用。

```typescript
// app/api/dashboard/status/route.ts
import { NextResponse } from "next/server";
import { getDashboardStatus, ensureCleanup } from "@/lib/playwright-dashboard";

// 服务端模块加载时注册退出清理钩子
ensureCleanup();

export async function GET() {
  const status = await getDashboardStatus();
  return NextResponse.json(status);
}
```

**验证**：`curl http://localhost:30141/api/dashboard/status` 返回 `{ url, ready, pid, error }`。

---

## 步骤 3：`components/PlaywrightDashboardPanel.tsx`（新增）

**职责**：渲染侧边栏底部面板，轮询 status，条件渲染 iframe。

**关键点**：
- `useState<boolean>(expanded)` 初始化从 `localStorage['pi-dashboard-panel-expanded']` 读取
- 切换时写回 localStorage
- `useEffect` 轮询 `/api/dashboard/status` 直到 `ready === true`，之后停止
- 渲染时：折叠态只显示标题 + 状态点；展开态显示 `<iframe>`
- iframe `key={url}` 强制在 URL 变化时重新挂载
- iframe 在折叠时 `src=""` 释放内存（Chrome 会暂停后台 iframe 但不释放）

**骨架**：

```tsx
"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { Tooltip } from "./Tooltip";

interface Status {
  url: string | null;
  ready: boolean;
  pid: number | null;
  error: string | null;
}

const STORAGE_KEY = "pi-dashboard-panel-expanded";

export function PlaywrightDashboardPanel() {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  });
  const [status, setStatus] = useState<Status>({ url: null, ready: false, pid: null, error: null });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch("/api/dashboard/status");
        const next: Status = await res.json();
        if (cancelled) return;
        setStatus(next);
        if (!next.ready) timer = setTimeout(poll, 2000);
      } catch {
        if (!cancelled) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  const toggle = () => {
    setExpanded((v) => {
      const next = !v;
      try { localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const dotColor = status.ready ? "var(--accent)" : status.error ? "#d44" : "#da3";

  return (
    <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--border)", minHeight: 0, flex: expanded ? "1 1 auto" : "0 0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "6px 10px", gap: 8, flexShrink: 0 }}>
        <button
          onClick={toggle}
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2, display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500 }}
          aria-label={expanded ? t("Collapse") : t("Expand")}
        >
          <span style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", display: "inline-block" }}>▶</span>
          <span>{t("Playwright Dashboard")}</span>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} title={status.error ?? (status.ready ? t("Ready") : t("Starting"))} />
        </button>
        {expanded && status.url && (
          <Tooltip content={t("Open in new tab")}>
            <a href={status.url} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 12, textDecoration: "none" }}>↗</a>
          </Tooltip>
        )}
      </div>
      {expanded && (
        <div style={{ flex: "1 1 auto", minHeight: 200, position: "relative" }}>
          {status.ready && status.url ? (
            <iframe
              key={status.url}
              src={status.url}
              sandbox="allow-scripts allow-same-origin allow-popups"
              style={{ width: "100%", height: "100%", border: "none", display: "block", background: "#1e1e1e" }}
              title="Playwright Dashboard"
            />
          ) : (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>
              {status.error ?? t("Starting...")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**验证**：单独渲染组件（Playwright 测试或开发态肉眼检查），折叠/展开切换无卡顿，状态点变绿后 iframe 加载。

---

## 步骤 4：`components/AppShell.tsx`（编辑 ~10 行）

**变更**：
1. 顶部 import 加一行：`import { PlaywrightDashboardPanel } from "./PlaywrightDashboardPanel";`
2. 在 `sidebarContent` 内（约 line 522 之前）插入 `<PlaywrightDashboardPanel />`

具体插入位置：`SessionSidebar` 组件结束、`Models/Skills/Prompts/Settings` 按钮条开始之间。按钮条包一层外层 div，按钮条自己的 `flexShrink: 0` 让它保持高度，面板用 `flex: 1 1 auto` 占据中间剩余空间。

```tsx
const sidebarContent = (
    <>
      <SessionSidebar ... />
      {/* ↓ 新增 ↓ */}
      <PlaywrightDashboardPanel />
      {/* ↑ 新增 ↑ */}
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", ... }}>
        ...Models/Skills/Prompts/Settings 按钮...
      </div>
    </>
  );
```

**验证**：`npm run dev`，打开 `http://localhost:30141`，侧边栏底部出现 "▶ Playwright Dashboard"，点击展开看到 iframe。

---

## 步骤 5：`hooks/useI18n.tsx`（编辑）

**新增键（英文值为 key，附 zh）**：

```typescript
"Playwright Dashboard" → "Playwright Dashboard",
"Open in new tab"     → "在新标签页打开",
"Starting..."         → "启动中...",
"Ready"               → "已就绪",
"Expand"              → "展开",
"Collapse"            → "收起",
"Starting"            → "启动中",
```

放在 `ZH_TRANSLATIONS` 已有 "Common-operation toasts" 注释块附近的合适位置。

---

## 步骤 6：端到端验证

1. `npm run dev`，浏览器开 `http://localhost:30141`
2. 侧边栏底部看到折叠的 "Playwright Dashboard"，状态点**黄色**（启动中）
3. 等 1-2 秒状态点变**绿色**（ready），点击展开
4. iframe 加载并显示 "No browser sessions yet"（Dashboard SPA 空状态）
5. 在另一个终端：`playwright-cli open https://playwright.dev`
6. 浏览器回到 pi-web 侧边栏，Dashboard 应**几秒内**出现新 session 条目（WS 推送）
7. 点击 session → Dashboard 内部渲染页面预览
8. 折叠面板再展开 → 状态保持（localStorage）
9. 刷新页面 → 面板折叠状态保持；Dashboard 子进程仍在跑（globalThis singleton 没被 hot-reload 清掉）
10. `Ctrl+B` 收起整个侧边栏 → 面板跟着隐藏；再次 `Ctrl+B` 显示
11. 终止 pi-web dev server → 子进程收到 SIGTERM（或父进程退出，detached 状态下还能活），下次启动 `npm run dev` 应能复用同一端口（如果没被占用）

---

## 后续可能

设计文档 §9 列了不做项。任何时候想推进可以参考：

- workspaceDir 显式指定（让 Dashboard 看到 agent 真正在跑的 session 而非 pi-web 项目的）
- annotate 模式（socket 协议桥接）
- 主题同步（iframe 内注入 CSS 变量）
- 消息附件化（agent 操作时的页面截图自动回流到 chat）