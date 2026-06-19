# Playwright Dashboard 集成到 pi-web 侧边栏 — 设计文档

> 目标：将 `playwright-cli show` 提供的 Playwright Dashboard 实时内嵌到 pi-web 侧边栏，全局开启、项目级生命周期（一直常驻）、可展开/收起。
>
> 范围：`/home/alone/p/pi-web/third/playwright-cli`（即 npm 包 `@playwright/cli`，当前 0.1.13）和 `/home/alone/p/pi-web`。

---

## 1. 背景与现状

`playwright-cli` 是微软官方的命令行浏览器自动化工具（"MCP 命令行版"），agent 在跑网页操作任务时会调它。`playwright-cli show` 会拉起一个 Playwright Dashboard 窗口，实时展示当前所有打开的浏览器 session、tab、page，并提供页面预览、标注（annotate）等能力。

当前问题：Dashboard 是独立 Chromium 窗口，看 agent 操作页面时要切出去，对照上下文不方便。期望：把它嵌进 pi-web 侧边栏，agent 在主窗口聊天时侧边就能看到浏览器画面。

---

## 2. playwright-cli show 的内部结构

调用链：

```
playwright-cli show
  ↓ spawn detached child (program.js:177)
node playwright-core/lib/entry/dashboardApp.js --sessionName=... --workspaceDir=...
  ↓ openDashboardApp() (coreBundle.js:67929)
  ├ if --port: startDashboardServer(...) + selfDestructOnParentGone
  └ else:    acquireSingleton(socket) + innerOpenDashboardApp()
```

### 2.1 服务器本体 `startDashboardServer` (coreBundle.js:67740)

- `HttpServer` 实例，监听 `127.0.0.1:<port>`（port 不传时随机，可用 `--port` / `--host` 覆盖）
- 路由：
  - `GET /` → 302 → `/index.html?ws=<wsGuid>`
  - `GET /<file>` → 静态文件（从 `lib/vite/dashboard/` 取，含 `index.html` / `assets/index-*.js` / `assets/index-*.css` / `playwright-logo.svg`）
  - `WS /ws/<wsGuid>` → 实时推送 session / page 变化（DashboardConnection 类）
- 返回 `{ url, reveal, triggerAnnotate, registerAnnotateWaiter, close }`

### 2.2 静态资源 `lib/vite/dashboard/`

```
index.html
playwright-logo.svg
assets/
  index-DpEq2p62.js     ← SPA bundle
  index-BY2S1tHT.css    ← SPA styles
  firefox*.svg          ← 浏览器图标
  codicon-*.ttf         ← 图标字体
  safari-*.svg
```

整个 Dashboard 是一个已构建好的 Vite SPA（`index.html` 里只有一个 `<div id="root">`，入口 `<script type="module" src="assets/index-*.js">`）。**不需要运行时构建，也不需要后端逻辑——只要能服务静态文件 + 暴露 WebSocket 就行。**

### 2.3 Session 发现机制 `Registry` (cli-client/registry.js)

Dashboard 自动发现"当前在跑的浏览器 session"靠的是 **sidecar registry**：

- 目录：`~/.cache/ms-playwright/daemon/<workspaceDirHash>/*.session`（Linux，`XDG_CACHE_HOME` 可覆盖；macOS/Windows 类似）
- `workspaceDirHash` = 当前 cwd 含 `.playwright/` 目录的 sha1 前 16 hex；fallback 是 `packageRoot`
- 每次 `playwright-cli open` 都会在 daemon 目录写一个 `<sessionName>.session` 文件，里面记录浏览器端口、当前 page URL 等
- Dashboard 启动时扫这个目录，所以**任何在同台机器、同一 workspace 下打开的浏览器都会被它看到**

意味着：pi-web 端只需启动一个 Dashboard 进程，agent 之后用 `playwright-cli open` 开的浏览器实例都会自动浮现到侧边栏，不需要 pi-web 自己接 registry。

### 2.4 单例与 socket

`acquireSingleton` 用一个 Unix domain socket (`dashboardSocketPath()`，在 daemon 目录里) 保证同一 workspace 下只能有一个无 `--port` 的 Dashboard 实例。但**传了 `--port` 会绕开单例**，直接监听指定端口。我们 MVP 选固定端口，所以不会和外部手动 `playwright-cli show` 冲突（那个走 socket 单例、随机端口）。

---

## 3. 集成方案选择

| 方案 | 实现 | 优劣 |
|---|---|---|
| **A. 子进程 + iframe**（推荐） | pi-web 启动时 spawn `playwright-cli show --host=127.0.0.1 --port=<固定>`，侧边栏 `<iframe>` 内嵌 | 零耦合；不引入新依赖；和现有 `lib/npx.ts` 模式一致 |
| B. 进程内 import | `require('playwright-core').tools.openDashboardApp({port, host})` 在 Next.js 里直接调 | 需要把 `playwright-core` 加进 pi-web 依赖；要自己实现 `RegistrySessionProvider` 注入；收益小 |

**MVP 选 A。** 子进程模式足够 — Dashboard 本身就是个完整的 HTTP 服务，iframe 跨域也没问题（WS 连的是同一个 `127.0.0.1:<port>`）。

---

## 4. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│ pi-web Next.js Server (port 30141)                                  │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ lib/playwright-dashboard.ts  (模块级 singleton)                │ │
│  │   startDashboard() spawn ─────────────────┐                   │ │
│  │   getDashboardUrl()                       │                   │ │
│  │   stopDashboard()                         │                   │ │
│  └───────────────────────────────────────────┼───────────────────┘ │
│                                              │ detached child       │
│  app/api/dashboard/status/route.ts           │ stdio: ignore       │
│   GET → { url, ready, pid }  ◀── polling ────┤                     │
│                                              │                     │
│  components/PlaywrightDashboardPanel.tsx  ───┘                     │
│   polls /api/dashboard/status                                     │
│   renders <iframe src={url} />                                     │
└─────────────────────────────────────────────────────────────────────┘
                        │
                        │ spawn playwright-cli show --port=4321
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ playwright-cli show (Node.js child process, detached)               │
│   HTTP 127.0.0.1:4321                                               │
│     GET  /              → 302 /index.html?ws=<guid>                │
│     GET  /<file>        → static SPA                               │
│     WS   /ws/<guid>     → live session/page stream                  │
│                                                                     │
│   reads ~/.cache/ms-playwright/daemon/<hash>/*.session              │
│   ↑                                                                   │
│   │ written by                                                       │
│   playwright-cli open https://example.com   (run by pi agent)       │
└─────────────────────────────────────────────────────────────────────┘
                        ▲
                        │ iframe
┌───────────────────────┴─────────────────────────────────────────────┐
│ Browser (localhost:30141)                                           │
│   <SessionSidebar>                                                  │
│     ...                                                              │
│   <PlaywrightDashboardPanel>   ← 新增                               │
│     [▾ Playwright Dashboard ●]   折叠态：状态条 + 标题              │
│     ┌───────────────────────────────────────────┐                   │
│     │ <iframe src="http://127.0.0.1:4321/">      │  展开态：实时预览 │
│     │   renders Vite SPA, lists browser sessions│                   │
│     └───────────────────────────────────────────┘                   │
│     <Models|Skills|Prompts|Settings>                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. 生命周期

**项目级、一直常驻**：

- 模块加载时（server boot）`startDashboard()` 启动子进程；用 `globalThis` 缓存 spawn Promise 和 child 句柄，避开 Next.js hot-reload（参考 `lib/rpc-manager.ts` 的 `globalThis.__piSessions` 模式）
- 子进程 `detached: true, stdio: 'ignore'`，`child.unref()` 防止它拖住 Node 退出
- pi-web 退出时（SIGTERM/SIGINT）`process.on('SIGTERM', stopDashboard)` → `process.kill(child.pid, 'SIGTERM')`
- 意外死亡：状态查询 API 返回 `ready: false`，前端面板显示"Down" + 重试按钮
- 端口冲突：`PI_WEB_DASHBOARD_PORT` 环境变量（默认 4321），启动失败时换下一个（4322, 4323...）直到可用

---

## 6. UI / UX

### 6.1 折叠态

底部一条细横条：

```
┌──────────────────────────────┐
│ ▸ Playwright Dashboard   ●   │  ← ● 绿色=ready / 黄色=starting / 红=down
└──────────────────────────────┘
```

### 6.2 展开态

```
┌──────────────────────────────┐
│ ▾ Playwright Dashboard   ●  ↗│  ← ↗ 在新 tab 打开完整 Dashboard
├──────────────────────────────┤
│ <iframe>                      │
│   Playwright Dashboard SPA    │
│   - Sessions list             │
│   - Page preview              │
│   - Tabs / DevTools / Console │
│ </iframe>                     │
└──────────────────────────────┘
```

- 高度：占满侧边栏剩余空间（flex-grow: 1），最小 200px
- 折叠状态写入 `localStorage['pi-dashboard-panel-expanded']`，刷新后保持
- iframe `sandbox="allow-scripts allow-same-origin allow-popups"`（Dashboard 自己弹窗做标注等需要）
- 跨域：父页面是 `localhost:30141`，iframe 是 `127.0.0.1:<port>`。WebSocket 同源（iframe 里连 `ws://127.0.0.1:<port>/ws/...`），跨父域无影响

### 6.3 与侧边栏的关系

放在 `SessionSidebar` 组件**之后**、Models/Skills/Prompts/Settings 按钮条**之前**，用 `marginTop: auto` 推到侧边栏底部（按钮条本来就在最下）。整体只占侧边栏容器的高度，**不影响 Ctrl+B 整边栏收起**。

---

## 7. 文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `lib/playwright-dashboard.ts` | 新增 | 子进程管理 singleton |
| `app/api/dashboard/status/route.ts` | 新增 | `GET /api/dashboard/status` |
| `components/PlaywrightDashboardPanel.tsx` | 新增 | 折叠面板 + iframe + 状态轮询 |
| `components/AppShell.tsx` | 编辑 ~10 行 | 在 `sidebarContent` 中插入 `<PlaywrightDashboardPanel />` |
| `hooks/useI18n.tsx` | 编辑 | 加几对 zh/en 文案（"Playwright Dashboard"、"Open in new tab" 等） |

预估净增 ~150 行代码。

---

## 8. 风险与已知坑

1. **`which playwright-cli` 失败**：面板显示 "Playwright CLI not installed"，附安装命令。启动时探测一次，写入 startup 日志。
2. **workspaceDirHash 不匹配**：Dashboard 默认用自己 cwd 的 hash。如果用户在 pi-web 项目目录跑 pi-web，但 agent 在别的目录跑 `playwright-cli`，hash 会不一致 → Dashboard 看不到 session。**MVP 不解决**；后续可以传 `--workspaceDir=...`（注意：这是 cli-client 的 `clientInfo.workspaceDir` 而非 agent cwd）。
3. **多 pi-web 实例**：每个用不同端口，文档说明 `PI_WEB_DASHBOARD_PORT` 怎么设。
4. **iframe CSS 变量不生效**：Dashboard 是跨域 iframe，pi-web 的主题 CSS 变量穿不过去。MVP 接受这点（Dashboard 自己的 dark theme 已经够用）。
5. **annotate 模式不可用**：MVP 跳过。`playwright-cli show --annotate` 需要走 socket 协议和单例 Dashboard 通讯，我们固定端口的实例走的是另一条路径。Dashboard 的核心价值（实时看页面）已经满足。
6. **WebSocket 在 iframe 里的兼容**：现代浏览器都支持，无需特殊处理。
7. **iframe 在 SPA 路由切换时残留**：用 React `key={url}` 强制卸载/挂载，或在 `expanded` 切到 false 时把 iframe 的 `src` 置空（释放内存）。

---

## 9. 后续可能（不做）

- 标注（annotate）模式：需要把 socket 协议桥接到 pi-web
- 自定义 session 选择器：让用户挑哪个 session 高亮
- 把 Dashboard 的浏览器预览直接作为 ChatWindow 内的 message 附件（更激进）
- 集成 WeChat 风格的"消息触发的浏览器截图"自动回流到 chat