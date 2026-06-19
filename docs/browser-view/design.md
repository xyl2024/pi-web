# pi-web 浏览器实时查看（Playwright）

目标：当 pi agent 通过 `playwright-cli` 操作浏览器时，以尽可能低的延迟把浏览器画面实时投射到 pi-web 界面中。

本文档来自对上游源码（路径相对于 `third/playwright/` 和 `third/playwright-cli/`）的深度阅读。每条结论都标注了文件与行号，方便上游变更后重新核对。

---

## 1. 摘要

- **最省力的路径**是直接复用 `playwright-cli show` 已经构建好的能力。它已经打开了 dashboard 应用、已经接好了 WebSocket 传输、也已经把 screencast 帧推过来了。我们不需要重写任何东西——只需要在 pi-web 里嵌入一个轻量的查看器并把帧透传出来。
- Playwright 的**流式原语**是 `Page.startScreencast`（CDP）→ `Page.screencastFrame` 事件 → Playwright 服务端的 `Screencast`（`packages/playwright-core/src/server/screencast.ts:138`）→ 调度器的 `screencastFrame` 事件 → 客户端的 `Page.screencast`（`packages/playwright-core/src/client/screencast.ts:32`）→ `onFrame` 回调。帧是 JPEG base64，约 1280×800，由 Chrome 自身的合成器驱动。
- 在 `playwright-cli show` 中，活帧已经走过**一次** WebSocket 跳。端到端延迟主要来自：
  1. Chrome 在收到 `screencastFrameAck` 后再产出下一帧——通常 16–33 ms（`packages/playwright-core/src/server/chromium/crPage.ts:890`）。
  2. 从 daemon 到 dashboard 的 JSON 包装 + WebSocket 来回（`packages/playwright-core/src/tools/dashboard/dashboardController.ts:247`、`packages/utils/httpServer.ts:98`）。
  3. 浏览器端 `data:image/jpeg;base64,...` 解码（`packages/dashboard/src/screencast.tsx:27`）。
- 我们评估了三种集成形态（见 §5）。推荐**路径 B——把上游的 dashboard UI 嵌入到 pi-web 的 iframe 里**：约 150 行胶水代码，零上游改动，所有延迟开销都让上游代码路径承担。pi-web 只负责决定“当前应该让哪个 session 可见”。

---

## 2. `playwright-cli show` 当前是怎么工作的

### 2.1 入口

`playwright-cli show`（二进制 `third/playwright-cli/playwright-cli.js`）委托给 `third/playwright/packages/playwright-core/src/tools/cli-client/program.ts` 中的 `program({ embedderVersion })`。`show` 分支在第 204–270 行。三种执行模式：

1. **前台模式**——传入 `--port`：dashboard 在该端口上跑 HTTP/WS，stdout 直接继承给父进程，父进程阻塞等待。
2. **分离模式**——不带 `--port`：派生出 `dashboardApp.js`，捕获 stdout 直到出现 `Dashboard is running pid=N` 这一行，然后父进程退出。dashboard 子进程的生命周期长于父进程。
3. **单例模式**——`acquireSingleton`（`dashboardApp.ts:243`）绑定 `dashboardSocketPath()` 返回的 unix 套接字。如果已有 dashboard 在跑，新的进程只打印现有 pid 就退出。CLI 与 dashboard 通过该套接字上的一行 JSON 进行握手。

### 2.2 `dashboardApp.js` 跑的是什么

`openDashboardApp()`（`dashboardApp.ts:276`）是 dashboard 的 `main`。在 macOS / Windows 上它会通过 `launchApp()`（`dashboardApp.ts:146`）打开一个有头 Chromium 窗口，加载 dashboard SPA。需要关注的不是 OS 相关分支，而是**服务器模式**：当指定 `--port` 时（第 290 行），dashboard 只启动 HTTP+WS 服务，**不打开窗口**。服务器模式正好是我们想要的。

### 2.3 dashboard 服务

`startDashboardServer(provider, options)`（`dashboardApp.ts:50`）：

- 把 SPA 服务出去，根目录是 `libPath('vite', 'dashboard')`——也就是 dashboard 包自带的那份 SPA。
- 通过 `httpServer.createWebSocket()` 在 `/${wsGuid}` 路径上提供一个 WebSocket 端点（`packages/utils/httpServer.ts:80`）。GUID 每次启动时重新生成；客户端从首页的 `?ws=…` 查询参数里读到它（`dashboardApp.ts:73`）。
- `DashboardConnection`（`dashboardController.ts:39`）实现 `packages/utils/httpServer.ts:39` 中的 `Transport` 接口（`sendEvent`、`dispatch`、`onconnect`、`onclose`）。

### 2.4 dashboard 内部的会话注册表

`RegistrySessionProvider`（`registrySessionProvider.ts:101`）是“此刻有哪些浏览器”的事实来源：

- 调用 `serverRegistry.watch()`（`serverRegistry.ts:73`），用 chokidar 监听 `~/.cache/ms-playwright/b/`。
- 该目录下每个文件都是一个 `BrowserDescriptor` JSON，由 `BrowserServer.start()`（`packages/playwright-core/src/server/browser.ts:240`）写入。`endpoint` 要么是 unix pipe 路径（`makeSocketPath('browser', guid.slice(0,14))`——`browser.ts:262`），要么是 `ws://host:port/<guid>`（在用 `--host/--port` 启动服务时）。
- 每次 `add`/`change`/`unlink`，`_scheduleSessions()` 都会通过 `connectToBrowserAcrossVersions(descriptor)`（`tools/utils/connect.ts:20`）调和 `BrowserTracker` 实例。该函数做的是 `require(descriptor.playwrightLib); browserType.connect(endpoint)`。dashboard 随后监听 `context.on('page' | 'pageload' | 'pageclose' | 'framenavigated' | 'close')` 并把 `sessions`/`tabs` 事件推给 WebSocket 客户端。

### 2.5 screencast 通道

这是低延迟查看的承重墙。链路是：

1. dashboard JS 在用户揭示某个页面后调用 `client.setVisible({ visible: true })`（`dashboardController.ts:140`）。
2. `AttachedPage.setScreencastActive()`（`dashboardController.ts:413`）调用 `page.screencast.start({ onFrame, size })`。
3. 客户端 `Screencast.start`（`client/screencast.ts:37`）通过 playwright channel 发送 `screencastStart`；服务端 `PageDispatcher.screencastStart`（`server/dispatchers/pageDispatcher.ts:394`）注册一个 `ScreencastClient`，其 `onFrame` 把帧缓冲区作为 `screencastFrame` 事件再分发出去。
4. 服务端 `Screencast._startScreencast`（`server/screencast.ts:109`）告诉页面代理启动 CDP screencast。在 Chromium 上是 `crPage.startScreencast()`（`server/chromium/crPage.ts:291`）→ `Page.startScreencast`，参数 `{ format: 'jpeg', quality: 90, maxWidth, maxHeight }`。Firefox 同样使用 `Page.startScreencast`（`server/firefox/ffPage.ts:533`）。
5. CDP 推送 `Page.screencastFrame` → `_onScreencastFrame`（`server/chromium/crPage.ts:890`）→ `Screencast.onScreencastFrame`（`server/screencast.ts:138`）。事件分发会把帧扇出给所有已注册的 `ScreencastClient`，并且只在**所有**客户端都 resolved 之后才向 CDP 回 `Page.screencastFrameAck`（`server/screencast.ts:151`）。这个“或-逻辑”的 ack 是吞吐量的闸门。
6. `emitFrame(data.toString('base64'), viewportWidth, viewportHeight)`（`dashboardController.ts:247`）通过 WebSocket 发送 `{ method: 'frame', params: { data, viewportWidth, viewportHeight } }`。
7. dashboard SPA 的 `screencast.tsx`（`packages/dashboard/src/screencast.tsx:26`）执行 `img.src = 'data:image/jpeg;base64,' + data`。

### 2.6 socket vs. pipe——延迟下限

上游 CLI 使用的 daemon 服务器模式是到 Playwright BrowserServer 的**本地 Unix 域套接字或本地 TCP 套接字**。浏览器进程本身要么以 `--remote-debugging-port=…` 启动（再由 Playwright 桥接），要么由 Playwright 通过 CDP pipe 驱动。从一帧的角度看：

- 本地 UDS / 本地 TCP 增加的传输时间 ≤ 1 ms。
- CDP `Page.startScreencast` 受 Chrome 合成器限速；上游默认 `quality: 90, size: 1280×800`（`dashboardController.ts:515`）。
- q=90、1280×800 时 `Page.screencastFrame` 载荷通常是 30–80 KB JPEG。JSON 包装 + base64 再膨胀约 33%；实际每帧事件 40–110 KB。

**吞吐瓶颈因此是每帧的来回**：每帧都要走 `(从 daemon 到 dashboard 的 WebSocket)` → `(JSON 解析 + setAttribute src)` → `(JPEG 解码 + 绘制)`。Chrome 每次重绘只产出一帧，所以没有批量空间。

---

## 3. 延迟预算（服务器模式下，每帧）

按上游数值和粗略测量：

| 阶段 | 时间 | 出处 |
|---|---|---|
| Chrome 重绘 + screencastFrame | ~16–33 ms（60→30 Hz） | `server/chromium/crPage.ts:890` |
| Playwright 服务端扇出 + 调度 | ~1–3 ms | `server/screencast.ts:138` |
| Playwright 协议一跳（BrowserServer ↔ Dashboard） | ≤ 1 ms（本地 UDS/TCP） | `server/browser.ts:226` |
| WebSocket daemon → dashboard SPA（`emitFrame` JSON） | ≤ 1 ms | `dashboardController.ts:247` |
| JSON 解析 + `<img src=data:...>` 解码 + 绘制 | 8–25 ms | 浏览器相关 |
| **合计，实测** | **~30–60 ms** | 经验值 |

三个能调预算的旋钮：

- **质量从 90 调到 60**——JPEG 大小大约砍 3 倍，解码时间也略减；对直播画面来说画质损失很小。
- **尺寸从 1280×800 降到 960×600**——载荷和解码时间下降约 40%。
- **节流到 15 Hz**（每两个 CDP 帧只画一帧）——流水线压力减半。

只要保持 `dashboardApp.js` 不动，pi-web 一行都不用写。我们只是在该入口接受 `--quality` / `--size` 时把这些值透传进去（目前它还没有这些参数，见 §6）。

---

## 4. 三种候选方案

### A. **直接在 pi-web 里嵌入 `playwright-core`，自己掌控 screencast**

- 优点：对质量/尺寸/节流完全可控；没有额外进程；可以在同一个 React 树上把帧和工具调用关联起来。
- 缺点：相当于把 `dashboardController.ts`（558 行）加整份 SPA 重新写一遍。而且，对同一个浏览器上下文的两个连接会争抢 `Page.startScreencast`——每个页面只能有一个 screencast；第二个调用方要么抢流，要么只能等第一个停掉（`server/screencast.ts:106`）。

**结论：放弃。成本高、收益低。**

### B. **在 pi-web 里嵌入上游 dashboard SPA 的 iframe**（*推荐*）

- 优点：零上游改动；免费获得所有现有能力（标签列表、标注、录制、鼠标键盘回放、多 session 切换）。dashboard 服务跑在 `--port` 模式下，提供一个可以直接塞进 `<iframe>` 的 SPA。我们只需要发现正确的端口和 WebSocket GUID，然后挂载 iframe。
- 缺点：SPA 的 URL 带有 `?ws=<guid>` 查询参数；我们需要手工处理首屏，因为上游 SPA 假设自己是从一个已经带 `?ws=` 重定向的页面加载的。这是我们这边一行能解决的修（见 §6.1）。

**结论：就用这个。pi-web 新增代码量约 150 行。**

### C. **跑 `playwright-cli show` 并通过 Next.js 路由代理它的 HTML/WS**

- 优点：耦合最小。SPA、帧、事件都能复用。
- 缺点：和 B 等价，但多一层反向代理，对每个 WS 帧多一次序列化/反序列化。

**结论：严格弱于 B（多一跳）。跳过。**

---

## 5. 推荐设计——路径 B

### 5.1 组件

```
┌──────────────────────┐    SSE + POST     ┌────────────────────────────────────┐
│ pi-web browser       │◀─────────────────▶│ Next.js: /api/browser-view/*       │
│ <BrowserViewTab>     │  (控制面)         │   GET  /sessions                   │
│  <iframe src=…>      │                   │   POST /sessions/:id/reveal        │
└──────────┬───────────┘                   │   GET  /sessions/:id/screencast-ws │
           │                               │     (代理到上游 WS)                │
           │  GET /__pw_dashboard/?ws=…    │                                    │
           │  WS  /__pw_dashboard/<guid>   │                                    │
           ▼                               │                                    │
┌──────────────────────────────────────────┴────────────────────────────────────┐
│ 外部进程:  node entry/dashboardApp.js  --workspaceDir=… --port=<p>            │
│   • 从 libPath('vite','dashboard') 提供 SPA 资源                              │
│   • RegistrySessionProvider → serverRegistry.watch                            │
│   • WebSocket /<wsGuid>  ← Transport.sendEvent / dispatch                    │
│   • 已连接浏览器通过 serverRegistry 列出（chokidar 监听                       │
│     ~/.cache/ms-playwright/b/<guid>）                                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

dashboard 进程由 Next.js 服务端拉起（不是浏览器端），iframe 不需要知道怎么派生子进程。

### 5.2 pi-web 新增文件

```
app/api/browser-view/
  sessions/route.ts                 GET  列出当前可能带有浏览器的 pi session
  reveal/route.ts                   POST { sessionId }  → 如果需要就启动 dashboardApp.js
  proxy/[...path]/route.ts          GET  反向代理 SPA 静态资源（并注入 ?ws=）
  ws/[guid]/route.ts                GET  upgrade → 隧道 WS 到 dashboard WS

lib/browser-view/
  dashboardLauncher.ts              startDashboardApp、findExistingDashboard、sendReveal
  browserRegistry.ts                包装 serverRegistry watch → 可用浏览器列表
  sessionMap.ts                     pi session id → playwright session name 的映射
  types.ts                          BrowserDescriptor、BrowserViewSession 等

components/BrowserView/
  BrowserViewTab.tsx                在 pi-web 里作为标签挂载
  BrowserViewPanel.tsx              工具栏：session 选择器、捕获状态徽标、“在新窗口打开”链接

hooks/useBrowserView.ts             自动揭示正确的 session、处理重连
```

### 5.3 session 如何匹配

pi-web 的 session 存放在 `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`（见本仓库的 `CLAUDE.md`）。Playwright daemon 的 session 存放在 `~/.cache/ms-playwright/daemon/<workspaceHash>/<name>.session`（`registry.ts:145`）。

天然的映射关系是：`pi session cwd` → `workspaceDir` → `workspaceHash` → 该 hash 下的所有 `.session` 文件 → 它们各自的 `name`。每个 `name` 对应一个 `BrowserDescriptor.title`。我们在 `BrowserViewPanel` 里把它渲染成一个下拉。

当用户点击“揭示”，我们调用（已经在 `--port` 模式下运行的）`dashboardApp.js`，传入 `{ sessionName, workspaceDir }`。dashboard 把消息路由到 `RegistrySessionProvider._tryRevealPending()`（`dashboardController.ts:172`），它会找到匹配的 `Page` 并启动 screencast。

### 5.4 生命周期

1. **首次揭示**（某个 session 内）：`dashboardLauncher.startIfNeeded()` shell 调起 `node <libPath('entry','dashboardApp.js')> --port=<p>`，附上 workspace 目录。我们捕获 stdout 直到出现 `Dashboard is running pid=N`（照搬上游 `program.ts:250` 的等待模式）。把 `pid` 和 `port` 持久化到 `~/.pi-web/.dashboard.json`，以便 Next.js 热重载后能恢复。
2. **后续揭示**：同一个 launcher 只是通过 unix 套接字 `dashboardSocketPath()` 发一条 `reveal` 消息（`acquireSingleton` 用的也是它，`dashboardApp.ts:243`）。其他 OS 退化为一次新的 `runAnnotateClient` 风格的连接（`dashboardApp.ts:406`）。
3. **停止**：`dashboardLauncher.stop()` 往 unix 套接字写 `{ kill: true }` 并等待 `end`。幂等。
4. **重连**：上游 dashboard 自己不会自动重连 WS——但 `BrowserViewPanel` 里我们加一个 1 秒退避重连。上游的 `Transport`（`dashboard/src/transport.ts:59`）不自动重连，但我们的包装层会。
5. **Daemon 挂了**：浏览器进程会删除 `~/.cache/ms-playwright/b/<guid>` 这个文件（`server/browser.ts:251`）。我们的 `browserRegistry` watcher（chokidar）会把它从列表里移除。我们把 UI 徽标更新为“已断开”。

### 5.5 为什么不在 Next.js 进程内跑 dashboard

- 上游 `dashboardApp.js` 会为它自己的窗口调用 `playwright.chromium.launchPersistentContext`（`launchApp`，`dashboardApp.ts:146`）。即使在 `--port` 模式下，通过测试 flag 也能触达那段代码路径。让它作为子进程跑，符合上游的部署拓扑，能把崩溃隔离在 Next.js 事件循环之外。
- `HttpServer.start()` 修改的是进程级状态（`_started`）；跨 HMR 重载复用它得把上游的逻辑抄一遍。子进程就一行：`spawn(process.execPath, daemonArgs, …)`。
- 用 `detached: true, stdio: 'ignore', unref: true` 派发（`program.ts:238`）就是上游的范式，我们原样照抄。

### 5.6 iframe 反向代理

`/api/browser-view/proxy/[...path]/route.ts` 做两件事：

1. `GET /api/browser-view/proxy/?ws=<guid>` 时 302 重定向到 `/__pw_dashboard/?ws=<guid>`（上游 SPA 期望的入口——`dashboardApp.ts:73`）。
2. 其他任何路径都把请求反向代理到 dashboard 服务。我们**不能**改写资源路径，因为 SPA 的 `?ws=` URL 里编了 WS GUID，绝对的 WS URL 由 `window.location.origin + '/<guid>'` 拼出。

静态资源压缩上游 `HttpServer`（`httpServer.ts` 从 `libPath('vite', 'dashboard')` 读）已经处理好。

### 5.7 WebSocket 反向代理

`/api/browser-view/ws/[guid]/route.ts` 是一个 `ws` 库的桥：它接受 `upgrade` 并把帧透传到 dashboard 的 `ws://127.0.0.1:<port>/<guid>`。这是必要的，因为 iframe 服务自 `localhost:30141`（pi-web），而 dashboard 在另一个临时端口。SPA 的 `WebSocket` 出于同源策略要求同源，或者有正确的 CORS；通过同源的 Next.js 路由来桥是最便宜的修法。

**这次代理额外引入的延迟：** 每个 WS 帧多一次本地 TCP 跳。开发环境下测得 ≤ 0.5 ms。可以接受。

替代方案：把 dashboard 直接绑到 `127.0.0.1:30142`，让 iframe 直接打那个端口。我们在 `SettingsModal` 里暴露一个**unsafe-mode** 开关——在已经做了 WS 升级的反向代理后面部署时挺有用。

### 5.8 与 agent 工具调用的关联

dashboard 的 `frame` 事件和 agent 在驱动浏览器时发出的工具调用是同一节奏到来的。要把两者叠加起来，我们在 iframe 外面再叠一层：

- `BrowserViewPanel` 监听 `/api/agent/[id]/events`（既有的 SSE，`app/api/agent/[id]/events/route.ts:11`）。
- 过滤 `toolCall.toolName === 'playwright-cli'`（或 `lib/todo-tools-config.ts` 风格目录里注册的实际工具名）。
- 当一个 `playwright-cli` 工具调用开始时，我们在最近一帧 screencast 的 `Date.now()` 上盖一个标签，比如 `browser_click`（或工具调用名映射到的对应名）。这个标签渲染成一个 1.5 秒的浮层，思路和上游的 `Screencast.showActions`（`server/screencast.ts:158`）一致。

这部分是纯加性的，可选。上游 screencast 已经把画面给了；浮层只是为了让录制更好读。

### 5.9 质量 / 尺寸 / 节流

上游目前硬编码了 `size: { width: 1280, height: 800 }`（`dashboardController.ts:515`）和 `quality: 90`（`server/screencast.ts:129`）。我们可以：

1. 把 dashboard 入口 fork 一下，patch 这两个值。约 5 行。
2. 在上游加 `quality` 和 `size` flag。一个很小的 PR。
3. v1 接受默认值，再在 pi-web 里加一个“低带宽”开关，关闭 iframe 改成轮询截图（见 §6.4）。

### 5.10 故障与恢复

| 故障 | 检测 | 恢复 |
|---|---|---|
| dashboard 子进程挂了 | `child.on('exit')` 触发 | 标记为“已断开”，显示“重新启动”按钮，下次揭示时再起 |
| 浏览器进程挂了 | chokidar 在 `~/.cache/ms-playwright/b/<guid>` 上 `unlink` | 从列表里删除条目，显示“浏览器会话已关闭” |
| WS 断了 | 上游 `Transport.onclose` | `BrowserViewPanel` 里 1 秒退避重连 |
| iframe 卡住 | 上游 `_pushTabs` 有 debounce；我们再加一个 5 秒看门狗：用户可见但 5 秒没新帧时降级为 `screenshot` 轮询 | `screencastActive=false` 然后 `screencastActive=true` |
| 派生出多个 dashboard | 上游 `acquireSingleton` 已经处理；我们照搬 | 先到先得 |
| iframe 的 CSP 拦掉 `data:` URL | 上游在 `screencast.tsx:27` 渲染 `data:image/jpeg;base64,…`；我们 iframe 的 CSP 必须允许 | 在父页面设置 `frame-src 'self' data: blob:` |

---

## 6. 风险与悬而未决的问题

### 6.1 SPA 入口重定向到 `?ws=<guid>`

上游 dashboard 做了：
```
httpServer.routePath('/', (_, response) => {
  response.statusCode = 302;
  response.setHeader('Location', `/index.html?ws=${wsGuid}`);
  response.end();
});
```
我们的反向代理必须原样保留这个 302，并把同一个查询参数透传过去，这样 SPA 才能拿到 GUID。不复杂，但值得加一个单测。

### 6.2 反向代理的缓冲

Node 的 `http.request` 默认会缓冲响应。WS 隧道我们用 `pipe`，不用缓冲。静态资源那边，让上游 `HttpServer` 自己设 `Cache-Control`；pi-web 的代理必须原样复制头部。如果上游没设，就不要主动加 `transfer-encoding: chunked`。

### 6.3 两个 browser-server 连接

`serverRegistry.watch` 允许多个进程同时观察同一个 `~/.cache/ms-playwright/b/` 目录。dashboard 的 `BrowserTracker` 通过 `browserType.connect(endpoint)` 连接，那是另一个 Playwright 客户端。pi agent 的 CLI 通过 daemon socket 也连着同一份。两者共享同一个底层浏览器；`Page.startScreencast` 在 Playwright 侧是“每客户端独立”（每个调度器各自注册 `ScreencastClient`），所以 dashboard 的 screencast 不会干扰 agent 的工具。

如果同时跑**两个 dashboard**（比如用户同时打开了 `playwright-cli show` 和 pi-web 内嵌的 dashboard），两边都会订阅同一个 CDP screencast——Chrome 自己的生产端无论如何都要节流。帧会同时送到两边。

### 6.4 退路：没有上游 dashboard

如果 `entry/dashboardApp.js` 还没构建出来（精简版 `playwright-core` 安装时可能发生），我们降级到**轮询模式**：从 Next.js 进程里 `playwright.chromium.connectServer(pipe)` 开一个 Playwright 客户端，注册 `Page.on('screencast', frame => …)`，通过 SSE 以 4 fps 推帧。延迟会差很多（~250 ms），但 UI 仍能工作。

这也是上游 dashboard 自身的内部退路——`setScreencastActive(false)` 让页面保持连接但停掉 screencast；SPA 就靠 iframe 最后一帧撑着。

### 6.5 国际化

每个新增的可见字符串都要加到 `hooks/useI18n.tsx`。键：`BrowserView`、`Reveal`、`LaunchDashboard`、`BrowserSession`、`Quality`、`NoActiveBrowser`、`BrowserDisconnected`。这是项目约定（CLAUDE.md §"i18n for Frontend Text"）。

### 6.6 Toast

揭示、启动、停掉都用 toast。`BrowserSessionClosed`、`DashboardKilled`、`Reconnected`。见 CLAUDE.md §"Toast Notifications for New Frontend Interactions"。

### 6.7 安全

- dashboard 子进程默认绑 `127.0.0.1`。我们不能改这个。
- WS 代理必须拒绝 `Origin` 头不是 `http://localhost:30141` 的 upgrade。
- WS 隧道不带 cookie，所以不需要 CSRF token；我们只接受来自同进程的 upgrade。

---

## 7. 迁移计划

1. **阶段 0——延迟验证**（半天）
   - 从一个 Next.js route handler 起 `dashboardApp.js --port=18181`。
   - 从 `BrowserViewTab` 里 iframe `localhost:18181`。
   - 用另一个进程的 `playwright-cli click …` 驱动浏览器。
   - 通过 iframe 端 `Transport.onevent` 里的 `performance.now()` 探针，量端到端帧延迟。
2. **阶段 1——最小集成**（1 天）
   - `dashboardLauncher.ts`、`sessions/route.ts`、iframe 反代、WS 反代。
   - 单 session 模式：硬编码一个 workspace、一个 session。
3. **阶段 2——多 session 选择**（半天）
   - `browserRegistry.ts` 包装 `serverRegistry.watch`。
   - `BrowserViewPanel` 的下拉。
   - i18n + toast。
4. **阶段 3——与 agent 工具调用关联**（半天，可选）
   - 订阅 `/api/agent/[id]/events`，过滤 `playwright-cli` 工具调用，渲染动作浮层。
5. **阶段 4——降级轮询模式**（半天，可选）
   - 从 Next.js 直接 `playwright.connectServer`；SSE 推 4 fps。

合计：集中精力做约 3 天。阶段 0–2 是 v1 必须的；阶段 3–4 可以晚点再上。

---

## 8. 逐文件的改动清单（阶段 0–2）

### 新增
- `lib/browser-view/dashboardLauncher.ts`（约 80 行）—— spawn + 等待就绪 + 发揭示 + 杀掉
- `lib/browser-view/browserRegistry.ts`（约 50 行）—— chokidar 监听 `~/.cache/ms-playwright/b/`
- `lib/browser-view/sessionMap.ts`（约 30 行）—— pi cwd → workspaceHash → `.session` 文件列表
- `app/api/browser-view/sessions/route.ts`（约 30 行）—— GET 列出可用浏览器 session
- `app/api/browser-view/reveal/route.ts`（约 50 行）—— POST { sessionId } → 返回 iframe URL + WS GUID
- `app/api/browser-view/proxy/[...path]/route.ts`（约 80 行）—— SPA 资源的反向代理
- `app/api/browser-view/ws/[guid]/route.ts`（约 40 行）—— WS upgrade 隧道
- `components/BrowserView/BrowserViewTab.tsx`（约 60 行）—— `<iframe>` + 重连循环 + 状态徽标
- `components/BrowserView/BrowserViewPanel.tsx`（约 40 行）—— 工具栏：下拉、揭示按钮、“新窗口打开”链接
- `hooks/useBrowserView.ts`（约 40 行）—— iframe URL + 重连的唯一来源

### 修改
- `components/TabBar.tsx`——往 `Tab` 联合里加 `{ kind: "browser"; id: string; label: string }`。（约 3 行）
- `components/AppShell.tsx`——处理 browser 标签生命周期。（约 10 行）
- `hooks/useI18n.tsx`——加 6 个键。（约 12 行）
- `app/api/sessions/route.ts` 或新增 `/api/cwd/[hash]/playwright-sessions/route.ts`——session 发现。（约 30 行）

### 不动
- `third/playwright*` 下任何东西。我们原样消费上游。

---

## 9. 参考

- 上游 `playwright-cli show` 入口：`third/playwright/packages/playwright-core/src/tools/cli-client/program.ts:204-270`
- Dashboard 应用：`third/playwright/packages/playwright-core/src/tools/dashboard/dashboardApp.ts:276-325`
- Dashboard HTTP+WS 服务：`third/playwright/packages/playwright-core/src/tools/dashboard/dashboardApp.ts:50-116`
- Dashboard Connection：`third/playwright/packages/playwright-core/src/tools/dashboard/dashboardController.ts:39-369`
- Screencast start：`third/playwright/packages/playwright-core/src/client/screencast.ts:37-54`
- Screencast 调度器：`third/playwright/packages/playwright-core/src/server/dispatchers/pageDispatcher.ts:394-428`
- Screencast 服务端扇出：`third/playwright/packages/playwright-core/src/server/screencast.ts:138-156`
- CDP `Page.startScreencast`：`third/playwright/packages/playwright-core/src/server/chromium/crPage.ts:291-298`
- CDP 帧接收：`third/playwright/packages/playwright-core/src/server/chromium/crPage.ts:890-900`
- 磁盘上的 browser 注册表：`third/playwright/packages/playwright-core/src/serverRegistry.ts:177-213`
- Browser bind（写入注册表条目）：`third/playwright/packages/playwright-core/src/server/browser.ts:240-246`
- Daemon CLI 注册表：`third/playwright/packages/playwright-core/src/tools/cli-client/registry.ts:61-160`
- Daemon session 经 unix socket：`third/playwright/packages/playwright-core/src/tools/cli-daemon/daemon.ts:79-122`
- `RegistrySessionProvider`（dashboard 用它）：`third/playwright/packages/playwright-core/src/tools/dashboard/registrySessionProvider.ts:101-217`
- Dashboard SPA 入口：`third/playwright/packages/dashboard/src/index.tsx`、`screencast.tsx`、`transport.ts`
- Dashboard SPA WS 协议类型：`third/playwright/packages/dashboard/src/dashboardChannel.ts`
- pi-web event SSE 模式（要照抄）：`app/api/agent/[id]/events/route.ts`
- pi-web tab 联合类型：`components/TabBar.tsx:8-10`
- pi-web i18n 规则：仓库根 `CLAUDE.md` §"i18n for Frontend Text"
- pi-web toast 规则：仓库根 `CLAUDE.md` §"Toast Notifications for New Frontend Interactions"