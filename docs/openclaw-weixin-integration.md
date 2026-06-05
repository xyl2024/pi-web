# `third/openclaw-weixin` — OpenClaw 微信通道插件解析

> 范围：`/home/alone/p/pi-web/third/openclaw-weixin`（即 npm 包 `@tencent-weixin/openclaw-weixin`，当前版本 2.4.3）。本文档只讲"它怎么和 OpenClaw 接驳"，不重复 README 里的用户操作步骤。

---

## 1. 插件在 OpenClaw 生态中的位置

```
┌──────────────────────────────────────────────────────┐
│  OpenClaw host (>=2026.3.22)                         │
│  ┌────────────────────────────────────────────────┐  │
│  │ src/plugins/loader                             │  │
│  │   ↓ 解析 openclaw.plugin.json + index.ts       │  │
│  │ register(api: OpenClawPluginApi)                │  │
│  │   ↓ api.registerChannel(weixinPlugin)          │  │
│  │ src/channels/registry                          │  │
│  │   ↓ gateway 拉起 account 启动循环              │  │
│  │ gateway.startAccount(ctx)                      │  │
│  │   ↓ weixin.startAccount → monitor → dispatch   │  │
│  │ src/agents/auto-reply (框架 AI 路由)          │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
                       ▲
                       │ Plugin SDK boundary
                       │   (openclaw/plugin-sdk/*)
                       ▼
┌──────────────────────────────────────────────────────┐
│  third/openclaw-weixin                               │
│  ┌────────────────────────────────────────────────┐  │
│  │ index.ts         ← 插件入口                     │  │
│  │ src/channel.ts   ← ChannelPlugin 实现           │  │
│  │   ├ gateway.{startAccount, stopAccount,         │  │
│  │   │   loginWithQrStart, loginWithQrWait}        │  │
│  │   ├ outbound.{sendText, sendMedia}              │  │
│  │   ├ config.{listAccountIds, resolveAccount,...} │  │
│  │   ├ auth.login                                  │  │
│  │   └ status.*                                    │  │
│  │ src/monitor/monitor.ts   ← getUpdates 长轮询    │  │
│  │ src/messaging/process-message.ts ← 入站调度     │  │
│  │ src/api/api.ts   ← ilink CGI JSON HTTP 客户端   │  │
│  │ src/cdn/{aes-ecb, cdn-upload, pic-decrypt}.ts   │  │
│  │ src/auth/{login-qr, accounts, pairing}.ts       │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
                       ▲ HTTPS JSON
                       │ iLink Bot CGI
                       ▼
        https://ilinkai.weixin.qq.com  +  CDN
```

**关键认知**：这个插件是 OpenClaw 的"外部（external）扩展"——它不打进 OpenClaw 主仓 `extensions/`，而是以独立 npm 包发布、通过 `openclaw plugin install` 装入。SDK 边界由 `openclaw/plugin-sdk/*` 一组子路径封装（见 `openclaw/packages/plugin-sdk` 与 `openclaw/src/plugin-sdk`）。

---

## 2. 装载入口：manifest + 入口模块

### 2.1 `openclaw.plugin.json`

文件 `third/openclaw-weixin/openclaw.plugin.json`：

```json
{
  "id": "openclaw-weixin",
  "version": "2.4.3",
  "channels": ["openclaw-weixin"],
  "channelConfigs": {
    "openclaw-weixin": { "schema": { "type": "object", "additionalProperties": true } }
  }
}
```

OpenClaw 装载器（`openclaw/src/plugins/manifest.ts`）读取后，把这个插件登记到 channel 列表里，并提供 CLI 子命令 `openclaw channels login --channel openclaw-weixin`。

### 2.2 `package.json` 里的 `openclaw` 块

`package.json` 末尾：

```jsonc
"openclaw": {
  "extensions":     ["./index.ts"],          // 源码/开发态入口
  "runtimeExtensions": ["./dist/index.js"],  // 发布态入口（prepublishOnly 编译）
  "channel": { "id": "openclaw-weixin", "order": 75, ... },
  "install": { "npmSpec": "@tencent-weixin/openclaw-weixin", "minHostVersion": ">=2026.3.22" }
}
```

`openclaw plugin install` 通过 `npmSpec` 拉包、`extensions` 拿到入口路径；`minHostVersion` 在装载早期做版本门控（和 `src/compat.ts` 双保险）。

### 2.3 `index.ts` — 插件入口

```ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { WeixinConfigSchema } from "./src/config/config-schema.js";

export default {
  id: "openclaw-weixin",
  name: "Weixin",
  description: "Weixin channel (getUpdates long-poll + sendMessage)",
  configSchema: buildChannelConfigSchema(WeixinConfigSchema),
  register(api: OpenClawPluginApi) {
    assertHostCompatibility(api.runtime?.version);   // ① 主机版本门控
    api.registerChannel({ plugin: weixinPlugin });    // ② 注册通道
  },
};
```

两步：
1. `assertHostCompatibility(api.runtime.version)` — 解析主机版本号（`YYYY.M.DD` 格式），与 `SUPPORTED_HOST_MIN = "2026.3.22"` 比较，过老直接抛错，提示用户装 `legacy` 包。
2. `api.registerChannel({ plugin: weixinPlugin })` — 把 `weixinPlugin: ChannelPlugin<ResolvedWeixinAccount>` 交给 OpenClaw 的 channel registry。

> `OpenClawPluginApi`（`openclaw/src/plugins/types.ts:2597`）是 OpenClaw 暴露给插件的全部面；`registerChannel` 接收 `ChannelPlugin | { plugin: ChannelPlugin }`（`types.ts:2639`）。

---

## 3. `ChannelPlugin` 契约 — `src/channel.ts`

`weixinPlugin`（`src/channel.ts:155-538`）实现了 OpenClaw 通道插件的全部能力（参考 `openclaw/src/channels/plugins/types.plugin.ts`）。本节按生命周期顺序讲。

### 3.1 静态描述（`meta` + `capabilities` + `messaging`）

```ts
meta: {
  id: "openclaw-weixin",
  label: "openclaw-weixin",
  selectionLabel: "openclaw-weixin (long-poll)",
  docsPath: "/channels/openclaw-weixin",
  blurb: "getUpdates long-poll upstream, sendMessage downstream; token auth.",
  order: 75,
},
capabilities: {
  chatTypes: ["direct"],
  media: true,
  blockStreaming: true,            // 支持块流式聚合后再发
},
streaming: {
  blockStreamingCoalesceDefaults: { minChars: 200, idleMs: 3000 },
},
messaging: {
  targetResolver: { looksLikeId: (raw) => raw.endsWith("@im.wechat") },
},
agentPrompt: {
  messageToolHints: () => [
    "To send an image or file to the current user, use the message tool with action='send' and set 'media' to a local file path or a remote URL. ...",
    "When creating a cron job ... delivery: { mode: 'announce', channel: 'openclaw-weixin', to: '<current_user_id@im.wechat>', accountId: '<current_AccountId>' }",
    ...
  ],
},
```

要点：
- **`chatTypes: ["direct"]`** — 只对接一对一私聊。群消息不处理。
- **`media: true`** — 通道能收/发 image/video/file/voice。
- **`blockStreaming: true` + `blockStreamingCoalesceDefaults`** — AI 块流时缓冲至少 200 字符或 3 秒空闲才下发，避免大模型一字一字刷。
- **`targetResolver.looksLikeId`** — 微信用户 ID 都以 `@im.wechat` 结尾，跳过 OpenClaw 的人名目录查询。
- **`agentPrompt.messageToolHints`** — 在 system prompt 里追加给 AI 的"自我提示"，教模型怎么用 message tool 发图、发文件、设 cron。

### 3.2 配置解析（`config`）

```ts
config: {
  listAccountIds: (cfg) => listWeixinAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveWeixinAccount(cfg, accountId),
  isConfigured: (account) => account.configured,
  describeAccount: (account) => ({ accountId, name, enabled, configured }),
}
```

`resolveWeixinAccount`（`src/auth/accounts.ts:366`）合并两层数据：
- `cfg.channels["openclaw-weixin"]`（含 `accounts.<id>.{name,enabled,cdnBaseUrl,routeTag}`）— 写进 `openclaw.json`。
- `~/.openclaw/openclaw-weixin/accounts/<id>.json` — QR 登录后由插件自身落盘的 token。

返回的 `ResolvedWeixinAccount`：
```ts
{ accountId, baseUrl, cdnBaseUrl, token?, enabled, configured, name? }
```

**`configured` = 是否有 token**（`Boolean(token)`）。

### 3.3 鉴权配置（`reload`）

```ts
reload: { configPrefixes: ["channels.openclaw-weixin"] }
```

向 OpenClaw 注册热重载前缀：用户改 `openclaw.json` 里的 `channels.openclaw-weixin.*` 时，gateway 知道要重启这个通道。

### 3.4 状态面板（`status`）

```ts
status: {
  defaultRuntime: { accountId: "", lastError: null, lastInboundAt: null, lastOutboundAt: null },
  collectStatusIssues: () => [],
  buildChannelSummary: ({ snapshot }) => ({ configured, lastError, lastInboundAt, lastOutboundAt }),
  buildAccountSnapshot: ({ account, runtime }) => ({ ...runtime, accountId, name, enabled, configured }),
}
```

提供 `openclaw status` 命令可读的摘要。运行态数据（`lastInboundAt` / `lastOutboundAt` / `lastError`）由 `gateway.startAccount` 里通过 `ctx.setStatus(...)` 实时写回。

### 3.5 登录（`auth.login`）— 通道级 CLI 子命令

```ts
auth: {
  login: async ({ cfg, accountId, verbose, runtime }) => {
    const account = resolveWeixinAccount(cfg, accountId);
    runtime?.log?.("正在启动...");
    const startResult = await startWeixinLoginWithQr({...});
    runtime?.log?.("用手机微信扫描以下二维码...");
    await displayQRCode(startResult.qrcodeUrl!);
    const waitResult = await waitForWeixinLogin({..., timeoutMs: 480_000});
    if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
      const normalizedId = normalizeAccountId(waitResult.accountId);
      saveWeixinAccount(normalizedId, { token, baseUrl, userId });
      registerWeixinAccountId(normalizedId);
      if (waitResult.userId) clearStaleAccountsForUserId(...);
      triggerWeixinChannelReload();   // 写 openclaw.json 让 gateway 立刻拾起
    }
  },
}
```

走完整流程：
1. `startWeixinLoginWithQr` 调 `ilink/bot/get_bot_qrcode` 取二维码串；
2. 终端 `qrcode-terminal` 渲染；
3. `waitForWeixinLogin` 调 `ilink/bot/get_qrcode_status` 长轮询（35s 超时），处理 `scaned / need_verifycode / expired / verify_code_blocked / scaned_but_redirect / confirmed / binded_redirect` 七种状态；
4. `confirmed` 时拿到 `bot_token / ilink_bot_id / ilink_user_id / baseurl`；
5. `normalizeAccountId` 把 `xxx@im.bot` 转为 `xxx-im-bot`（文件系统安全）；
6. `saveWeixinAccount` 写入 `~/.openclaw/openclaw-weixin/accounts/<id>.json`（token + baseUrl + userId，`chmod 600`）；
7. `registerWeixinAccountId` 把 ID 追加到 `accounts.json` 索引；
8. `clearStaleAccountsForUserId` 清理同一个 userId 的旧账号（防止同一用户多开冲突）；
9. `triggerWeixinChannelReload` 把 `channels.openclaw-weixin.channelConfigUpdatedAt` 写到 `openclaw.json`，触发 gateway reload。

> **ID 双形态兼容**：`loadWeixinAccount` 在拿 token 时除了查归一化 ID，还会 `deriveRawAccountId(normalizedId)` 退回旧的 `xxx@im.bot` 文件名（`src/auth/accounts.ts:25-33, 156-174`）。

### 3.6 网关生命周期（`gateway`）— 核心

```ts
gateway: {
  startAccount,                  // 启动一个账号的入站循环
  stopAccount,                   // 关停 + 通知后端
  loginWithQrStart,              // 给 gateway RPC 用的 QR Start
  loginWithQrWait,               // 给 gateway RPC 用的 QR Wait
}
```

#### 3.6.1 `startAccount(ctx)`（`channel.ts:394-463`）

被 OpenClaw gateway 在每个需要在线的 account 上调用一次。`ctx` 是 `ChannelGatewayContext<ResolvedAccount>`（`openclaw/src/channels/plugins/types.adapters.ts:244`），含 `cfg / account / runtime / abortSignal / channelRuntime / setStatus / log / getStatus`。

执行步骤：
1. **必备校验**：`ctx.channelRuntime` 必须在（`>=2026.2.19` 才有；`package.json` 的 peerDependency 写 `>=2026.3.22` 双保险）。缺失就抛错。
2. **`restoreContextTokens(accountId)`** — 从 `accounts/<id>.context-tokens.json` 把上次会话的 `contextToken` 缓存恢复到内存。
3. **`setStatus({ running: true, lastStartAt, lastEventAt })`** — 把运行状态写回框架。
4. **`notifyStart({ baseUrl, token })`** — 调 `ilink/bot/msg/notifystart` 通知后端"通道上线"。失败不阻塞（`warn` 然后继续）。
5. **lazy import** `monitorWeixinProvider`（`channel.ts:451`，动态 `await import("./monitor/monitor.js")`） — 显式注释解释：避免在 register 阶段把 `monitor → process-message → command-auth` 整条链拉进内存，让 provider registry 在 account 真正起来之前先稳。
6. **调用 `monitorWeixinProvider({...})`** 启动长轮询。

#### 3.6.2 `stopAccount(ctx)`

仅做 `notifyStop` —— `ilink/bot/msg/notifystop` 通知后端"通道下线"，best-effort 失败不抛。

> **关键**：`ctx.abortSignal` 在 monitor 里被透传给 `getUpdates` 的 `AbortController`，保证 gateway 停 channel 时 inflight 长轮询立刻被打断（`monitor.ts:104`），否则 5s budget 超了 monitor 不会被重启（issue #141）。

#### 3.6.3 `loginWithQrStart / Wait` — 同步版 QR 登录

跟 `auth.login` 类似但是给 HTTP/UI 调用的（不阻塞 stdin）。`start` 返回 `sessionKey`；client 把它在 `wait` 时回传。成功后同样 `saveWeixinAccount` + `triggerWeixinChannelReload`。

### 3.7 出站发送（`outbound`）

```ts
outbound: {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  sendText: async (ctx) => { ... },
  sendMedia: async (ctx) => { ... },
}
```

#### 3.7.1 账号消歧

`resolveOutboundAccountId(cfg, to)`（`channel.ts:66-107`）处理 cron/系统级出站没带 `accountId` 的场景：
- 0 账号 → 报错。
- 1 账号 → 直接用。
- ≥2 账号 → 用 `findAccountIdsByContextToken` 找哪个 account 跟目标 `to` 还在活跃对话里：
  - 唯一命中 → 用它；
  - 多重命中 → 歧义错误，要求 caller 给 `accountId`；
  - 无命中 → 报错。

#### 3.7.2 `sendText(ctx)`（`channel.ts:213-224`）

1. 解析 `accountId`（缺省走 `resolveOutboundAccountId`）；
2. `assertSessionActive`（`session-guard.ts:43-50`）—— 假如这个账号被 pause（见 §4.5），直接抛；
3. `account.configured` 校验；
4. `StreamingMarkdownFilter` 走一遍流式 markdown 过滤（去掉 CJK 上的斜体、头标记、图像等微信不支持的语法，`src/messaging/markdown-filter.ts`）；
5. `applyWeixinMessageSendingHook`（`outbound-hooks.ts:18-52`）—— 调用 OpenClaw 框架的 `message_sending` 钩子，允许别的插件改写/取消；
6. `sendMessageWeixin` → `api.sendMessage` → `ilink/bot/sendmessage`（HTTP POST JSON）；
7. `emitWeixinMessageSent` —— `message_sent` 钩子，fire-and-forget。

#### 3.7.3 `sendMedia(ctx)`（`channel.ts:225-292`）

`mediaUrl` 形态判断：
- 不带 `://` → 当成本地路径；`file://` 解 URL；相对路径 `path.resolve`。
- `http://` / `https://` → 走 `downloadRemoteImageToTemp` 下载到 `~/.openclaw/tmp/weixin/media/outbound-temp/`，扩展名由 Content-Type 推断。
- 然后 `sendWeixinMediaFile`（`messaging/send-media.ts:17`）按 MIME 分流：
  - `video/*` → `uploadVideoToWeixin` + `sendVideoMessageWeixin`
  - `image/*` → `uploadFileToWeixin` + `sendImageMessageWeixin`
  - 其它 → `uploadFileAttachmentToWeixin` + `sendFileMessageWeixin`（文件名走附件）
- 每条 media 都附 AES-128-ECB 加密的 CDN 引用（`encrypt_query_param` + `aes_key` + `encrypt_type: 1`）。

---

## 4. 长轮询 Monitor — `src/monitor/monitor.ts`

```ts
while (!abortSignal?.aborted) {
  const resp = await getUpdates({
    baseUrl, token,
    get_updates_buf: getUpdatesBuf,
    timeoutMs: nextTimeoutMs,
    abortSignal,                          // 来自 gateway 的 ctx.abortSignal
  });
  ...
  for (const full of list) {
    const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);
    await processOneMessage(full, { ... });
  }
}
```

### 4.1 同步游标 `get_updates_buf`

服务端用 `get_updates_buf` 字符串当长轮询的断点续传句柄（`storage/sync-buf.ts`）。
- 启动时从 `accounts/<id>.sync.json` 读出来；
- 每次成功响应里 `resp.get_updates_buf` 落盘；
- 兼容路径：归一化 ID、旧 `xxx@im.bot` 命名、`agents/default/sessions/.openclaw-weixin-sync/default.json` 三级回退。

### 4.2 长轮询超时自适应

第一次默认 35s；响应里 `longpolling_timeout_ms` 覆盖下次（服务端提示的窗口）。

### 4.3 错误退避

| 情况 | 处理 |
|---|---|
| `AbortError` 且 `abortSignal.aborted` | 干净退出 |
| `AbortError` 且非外部 abort | 当成"客户端超时"，返回空响应（保留兼容）|
| `errcode === -14`（session expired）| `pauseSession(accountId)` —— 一小时不调任何 API（见 §4.5）|
| 其它 API 错误 | `consecutiveFailures++`；到 3 次退避 30s 重试 |
| 异常抛出 | 同上退避 |

### 4.4 配置缓存（typing ticket）

`WeixinConfigManager`（`api/config-cache.ts`）按 `userId` 缓存 `getConfig` 返回的 `typing_ticket`：
- TTL 24h ± 随机抖动；
- 失败指数退避 2s → 4s → ... → 1h 上限；
- 只关心 `typing_ticket` 一个字段。

### 4.5 Session 暂停门控

`api/session-guard.ts`：
- `SESSION_EXPIRED_ERRCODE = -14`；
- 命中就 `pauseSession` —— 把 `accountId → until-timestamp` 记进程内 `Map`；
- 暂停期间所有 `assertSessionActive()` 抛"session paused, N min remaining"；
- 1 小时（`SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000`）后自动放行。

---

## 5. 入站消息处理 — `src/messaging/process-message.ts`

每条 `getUpdates` 返回的消息走以下流水线：

```
WeixinMessage (item_list: Text|Image|Voice|File|Video)
  │
  │ ①  文本以 / 开头 → handleSlashCommand 拦截（/echo, /toggle-debug）
  │
  │ ②  downloadMediaFromItem → CDN 下载 + AES-128-ECB 解密 + (silk→wav)
  │     优先 image > video > file > voice；缺则查找 ref_msg 引用
  │     落盘通过 ctx.channelRuntime.media.saveMediaBuffer（统一媒体存储）
  │
  │ ③  weixinMessageToMsgContext → MsgContext
  │     Body / From=To / AccountId / OriginatingChannel / ChatType: direct
  │     MediaPath / MediaType（绝不传 MediaUrl — CDN URL 是加密短链）
  │
  │ ④  resolveSenderCommandAuthorizationWithRuntime (dmPolicy: "pairing")
  │     readAllowFromStore 读 framework 的
  │       credentials/openclaw-weixin-<accountId>-allowFrom.json
  │     旧装没有则降级到 account 的 userId
  │
  │ ⑤  resolveDirectDmAuthorizationOutcome
  │     "disabled" | "unauthorized" → 丢消息
  │
  │ ⑥  resolveAgentRoute → agentId + sessionKey（按 dmScope 路由）
  │     设到 ctx.SessionKey 让 dispatch 写到正确 session
  │
  │ ⑦  ctx.channelRuntime.reply.finalizeInboundContext(ctx) → finalized
  │
  │ ⑧  ctx.channelRuntime.session.recordInboundSession({...})
  │     落 storePath = session.resolveStorePath(cfg, { agentId })
  │     updateLastRoute(主 session key, channel, to, accountId)
  │
  │ ⑨  setContextToken(accountId, from_user_id, context_token)
  │     内存 + 磁盘持久化（inbound.ts）
  │
  │ ⑩  createTypingCallbacks → 5s keepalive 的 sendTyping (start/stop)
  │     sendTyping 调 ilink/bot/sendtyping，status=1/2 (TYPING/CANCEL)
  │
  │ ⑪  createReplyDispatcherWithTyping({ deliver, onError })
  │     deliver:
  │       - StreamingMarkdownFilter
  │       - applyWeixinMessageSendingHook
  │       - text-only: sendMessageWeixin
  │       - media: 解析 mediaUrl → 本地/远程 → upload + sendXxxMessageWeixin
  │       - emitWeixinMessageSent (fire-and-forget)
  │     onError: 走 sendWeixinErrorNotice 反馈用户
  │
  │ ⑫  withReplyDispatcher({ run: () => dispatchReplyFromConfig(...) })
  │     这是 AI 真正的调度点：框架读 finalized → 跑 agent → deliver 回调
  │
  │ ⑬  finally: markDispatchIdle()
  │     调试模式（debug-mode.json）开启时，最后再发一条全链路耗时
  └
```

### 5.1 命令鉴权集成点

`resolveSenderCommandAuthorizationWithRuntime`（从 `openclaw/plugin-sdk/command-auth`）接收：
- `cfg, rawBody, isGroup, dmPolicy, configuredAllowFrom, configuredGroupAllowFrom, senderId, isSenderAllowed, readAllowFromStore, runtime`

返回 `{ senderAllowedForCommands, commandAuthorized }`：
- `commandAuthorized` 写入 `ctx.CommandAuthorized`；
- `resolveDirectDmAuthorizationOutcome` 把结果投到 `enabled / disabled / unauthorized` 三态。

### 5.2 路由与 session

`channelRuntime.routing.resolveAgentRoute({ cfg, channel, accountId, peer: { kind: "direct", id: ctx.To } })`：
- 框架按 `session.dmScope` 算出 `agentId` + `sessionKey` + `mainSessionKey`；
- 插件把 `route.sessionKey` 设进 `ctx.SessionKey`，避免落回 `agent:main:main` 默认 session。

`recordInboundSession` 把这条消息登记到 `cfg.session.store` 指定的 session store（SQLite 或文件），`updateLastRoute` 让"最近一次"指示器能指回正确的私聊。

### 5.3 框架 → 插件的运行时面（`ctx.channelRuntime.*`）

| 字段 | 用途 |
|---|---|
| `runtime.reply.createReplyDispatcherWithTyping` | 创建出站分发器（带 typing indicator 联动） |
| `runtime.reply.withReplyDispatcher` | 包裹整个 AI 调度，确保 dispatcher lifecycle 收尾 |
| `runtime.reply.dispatchReplyFromConfig` | 真正的"读 agent、跑模型、回调 deliver" |
| `runtime.reply.finalizeInboundContext` | 规范化 ctx 字段（CommandAuthorized / Body / MediaPath 等） |
| `runtime.reply.resolveHumanDelayConfig` | 取人类化延迟（流式打字前的停顿）|
| `runtime.routing.resolveAgentRoute` | 把 ctx.To 解析成 agentId + sessionKey |
| `runtime.session.resolveStorePath` | 取 session 文件路径 |
| `runtime.session.recordInboundSession` | 落 session 元信息 |
| `runtime.media.saveMediaBuffer` | 把入站媒体 buffer 写到框架统一目录（返回 path）|
| `runtime.commands.*` | 命令授权 |
| `channelRuntime` 类型 | `PluginRuntimeChannel`（`openclaw/src/plugins/runtime/types-channel.ts:73`）|

> 这层 runtime 由 OpenClaw 启动通道时通过 `createPluginRuntime().channel` 构造并注入（`types.adapters.ts:303-313` 注释明示）。

### 5.4 出站钩子（`outbound-hooks.ts`）

- **发前**：`applyWeixinMessageSendingHook` —— 调 `getGlobalHookRunner().runMessageSending(...)`，返回 `{ cancel, content }`；cancel 跳出发送，content 替换原文。
- **发后**：`emitWeixinMessageSent` —— `fireAndForgetHook(runMessageSent(...))`，失败不阻塞。

把钩子错误全部吞掉（`try/catch`），记 warn 继续发送。

### 5.5 斜杠命令（`slash-commands.ts`）

入站文本以 `/` 开头时先尝试本地指令（不经 AI）：
- `/echo <msg>` —— 直接回放，附带平台→插件延迟；
- `/toggle-debug` —— 翻转当前账号的 debug 模式（`debug-mode.ts` 持久化到 `~/.openclaw/openclaw-weixin/debug-mode.json`）。

不识别则返回 `handled: false`，继续走 AI 管道。

---

## 6. 鉴权 / 配对（pairing）— `src/auth/pairing.ts`

微信通道没有原生白名单，所以允许名单走 OpenClaw 框架的 channel allowFrom 机制：

```
~/.openclaw/credentials/openclaw-weixin-<safeAccountId>-allowFrom.json
{
  "version": 1,
  "allowFrom": ["u123@im.wechat", "u456@im.wechat"]
}
```

- `safeKey` 把 `channelId + accountId` 里的 `\\/:*?"<>|` 转成 `_`，并拒绝 `..`；
- `readFrameworkAllowFromList` 读出来给 `process-message` 的 `readAllowFromStore` 用；
- `registerUserInFrameworkStore` —— 配合 QR 配对流程把新用户写进去（用 `openclaw/plugin-sdk/infra-runtime` 的 `withFileLock` 防并发，参数 `retries: 3, factor: 2, minTimeout: 100ms, maxTimeout: 2s, stale: 10s`）。

`processOneMessage` 里：
```ts
readAllowFromStore: async () => {
  const fromStore = readFrameworkAllowFromList(deps.accountId);
  if (fromStore.length > 0) return fromStore;
  const uid = loadWeixinAccount(deps.accountId)?.userId?.trim();
  return uid ? [uid] : [];
},
```

旧装没写 allowFrom 时回退到 `accounts/<id>.json` 里的 `userId`（登录时存进去的 `ilink_user_id`）。

---

## 7. 后端 HTTP API（CGI 协议）

> 这一节跟 README 同源，但更聚焦"代码里实际怎么发、对应端点"。

### 7.1 客户端基座 — `src/api/api.ts`

请求共性：
- `Content-Type: application/json`
- `AuthorizationType: ilink_bot_token`（固定）
- `Authorization: Bearer <token>`
- `X-WECHAT-UIN`: 随机 uint32 → decimal string → base64（每个请求换一个）
- `iLink-App-Id`: `package.json` 顶层 `ilink_appid`（这里写死 `"bot"`）
- `iLink-App-ClientVersion`: `0x00MMNNPP`，版本号拆 major/minor/patch
- `SKRouteTag`: 来自 `openclaw.json` 的 `channels.openclaw-weixin.routeTag`（可选）

每个请求 body 都带 `base_info: { channel_version, bot_agent }`：
- `channel_version` 来自 `package.json.version`；
- `bot_agent` 来自 `channels.openclaw-weixin.botAgent`，过 `sanitizeBotAgent` —— UA-style 语法 `Name/Version (comment)`，非法 token 静默丢弃，超过 256 字节按 token 从尾砍，默认 `"OpenClaw"`。

GET / POST 通用：
- 客户端超时 = 内部 `AbortController`；
- 外部 `abortSignal`（如 `gateway.stopAccount`）合进同一个 controller；
- `4xx/5xx` 抛错；非 `AbortError` 向上抛。

### 7.2 端点清单

| 端点 | 方法 | 调用方 | 超时 |
|---|---|---|---|
| `ilink/bot/getupdates` | POST | `monitor` | 35s（服务端 `longpolling_timeout_ms` 可覆盖）|
| `ilink/bot/sendmessage` | POST | `send.ts`, `send-media.ts` | 15s |
| `ilink/bot/getuploadurl` | POST | `cdn/upload.ts` | 15s |
| `ilink/bot/getconfig` | POST | `api/config-cache.ts` | 10s |
| `ilink/bot/sendtyping` | POST | `process-message.ts` typing callbacks | 10s |
| `ilink/bot/msg/notifystart` | POST | `gateway.startAccount` | 10s |
| `ilink/bot/msg/notifystop` | POST | `gateway.stopAccount` | 10s |
| `ilink/bot/get_bot_qrcode?bot_type=N` | POST | `auth/login-qr.ts` | 无显式（依赖 TCP）|
| `ilink/bot/get_qrcode_status?qrcode=...&verify_code=...` | GET | `auth/login-qr.ts` | 35s（长轮询）|

### 7.3 媒体协议

#### 入站（`media-download.ts` + `pic-decrypt.ts`）
- 每个 `ImageItem / VoiceItem / FileItem / VideoItem` 都有 `media.encrypt_query_param`、`media.aes_key`、`media.full_url`（可选）。
- 优先用 `full_url`，没有就 `buildCdnDownloadUrl(encrypt_query_param, cdnBaseUrl)` 拼。
- `parseAesKey` 支持两种编码：
  - `base64(raw 16 bytes)` —— 图片常见；
  - `base64(hex string of 16 bytes)` —— 文件/语音/视频常见，先 base64 解码再 hex 解码。
- `decryptAesEcb(ciphertext, key)` 走 Node `createDecipheriv('aes-128-ecb', key, null)`（PKCS7 隐式）。
- `saveMediaBuffer(buf, mime, 'inbound', 100MiB)` 落盘到框架统一媒体目录。
- 语音：解出 SILK buffer → `silkToWav` (`silk-wasm` decode → WAV header 封装) → `audio/wav`；转码失败回落到 `audio/silk`。
- 100 MiB 硬上限（`WEIXIN_MEDIA_MAX_BYTES`）。

#### 出站（`cdn/upload.ts` + `cdn-upload.ts` + `send.ts`）
- `uploadMediaToCdn`：
  1. 读文件 → `rawsize` + `rawfilemd5`（明文 MD5）+ `filesize = aesEcbPaddedSize(rawsize)` + 16 字节随机 `aeskey` + 32 字节 hex `filekey`。
  2. `getUploadUrl({ filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey })` → `{ upload_full_url, upload_param, thumb_upload_param? }`。
  3. `uploadBufferToCdn`：明文 → `encryptAesEcb` 加密 → `POST` 到 `upload_full_url ?? buildCdnUploadUrl({cdnBaseUrl,uploadParam,filekey})`，body 是 ciphertext。响应头 `x-encrypted-param` 是下载参数。
  4. 最多 3 次重试，4xx 直接抛（不重试）。
- 拼装 `MessageItem`：
  - `image_item.media = { encrypt_query_param, aes_key (base64), encrypt_type: 1 }`、`image_item.mid_size = fileSizeCiphertext`
  - `video_item.media = {...}` + `video_size = fileSizeCiphertext`
  - `file_item.media = {...}` + `file_name` + `len = String(fileSize)`
- 发送：text caption 单独一个请求先发（如果有），media item 再单独发一个请求 —— **每个 `item_list` 只装一项**（微信协议要求？）。

### 7.4 typing indicator

`getConfig` 拿到 `typing_ticket`（base64），每次 inbound 走 5s keepalive `sendTyping` `status=1`；reply 完成 `status=2` 取消。`createTypingCallbacks`（来自 `openclaw/plugin-sdk/channel-runtime`）负责 keepalive 与错误降级。

### 7.5 长轮询协议

```jsonc
// POST ilink/bot/getupdates
{
  "get_updates_buf": "<上次响应回的同步游标>",
  "base_info": { "channel_version": "2.4.3", "bot_agent": "OpenClaw" }
}

// Response
{
  "ret": 0,
  "msgs": [ /* WeixinMessage[] */ ],
  "get_updates_buf": "<新游标，磁盘持久化>",
  "longpolling_timeout_ms": 35000
}
```

错误：`ret != 0` 或 `errcode != 0`，其中 `errcode === -14` = session expired。

---

## 8. SDK 边界 — 插件 import 的子路径

| 子路径 | 来源 | 用途 |
|---|---|---|
| `openclaw/plugin-sdk/plugin-entry` | `src/plugin-sdk/plugin-entry.ts` | `OpenClawPluginApi` 类型 |
| `openclaw/plugin-sdk/channel-config-schema` | `src/plugin-sdk/channel-config-schema.ts` | `buildChannelConfigSchema(Zod)` 把 Zod 转成 OpenClaw config schema |
| `openclaw/plugin-sdk/core` | `src/plugin-sdk/core.ts`（含 `packages/plugin-sdk`） | `ChannelPlugin / OpenClawConfig / PluginRuntime` 类型 |
| `openclaw/plugin-sdk/account-id` | `src/plugin-sdk/account-id.ts` | `normalizeAccountId` |
| `openclaw/plugin-sdk/infra-runtime` | `src/plugin-sdk/infra-runtime.ts` | `withFileLock`, `resolvePreferredOpenClawTmpDir` |
| `openclaw/plugin-sdk/config-runtime` | `src/plugin-sdk/config-runtime.ts` | `loadConfig`, `writeConfigFile` |
| `openclaw/plugin-sdk/channel-contract` | `src/plugin-sdk/channel-contract.ts` | `ChannelAccountSnapshot` |
| `openclaw/plugin-sdk/channel-runtime` | `src/plugin-sdk/channel-runtime.ts` | `createTypingCallbacks` |
| `openclaw/plugin-sdk/command-auth` | `src/plugin-sdk/command-auth.ts` | `resolveSenderCommandAuthorizationWithRuntime`, `resolveDirectDmAuthorizationOutcome` |
| `openclaw/plugin-sdk/hook-runtime` | `src/plugin-sdk/hook-runtime.ts` | `fireAndForgetHook`, `buildCanonicalSentMessageHookContext`, `toPluginMessage*` |
| `openclaw/plugin-sdk/plugin-runtime` | `src/plugin-sdk/plugin-runtime.ts` | `getGlobalHookRunner` |
| `openclaw/plugin-sdk/reply-runtime` | `src/plugin-sdk/reply-runtime.ts` | `ReplyPayload` 类型 |

> 这些都是 OpenClaw 的**公开 SDK 边界**（参考 `openclaw/src/plugin-sdk/CLAUDE.md`）。插件作者**严禁**直接 import `openclaw/src/channels/**` 或 `openclaw/src/agents/**` 内部 —— 那个层级只是 `src/channels/CLAUDE.md` 给核心用的。

---

## 9. 持久化与文件布局

```
~/.openclaw/
├── openclaw.json                                  # 主配置
│   └── channels.openclaw-weixin: {
│         botAgent?, cdnBaseUrl?, routeTag?,
│         channelConfigUpdatedAt (login 时刷新),
│         accounts: { "<id>": { name?, enabled?, cdnBaseUrl?, routeTag? } }
│       }
├── openclaw-weixin/
│   ├── accounts.json                              # 已注册账号 ID 列表
│   ├── accounts/
│   │   ├── <accountId>.json                       # { token, baseUrl, userId, savedAt }
│   │   ├── <accountId>.sync.json                  # { get_updates_buf }
│   │   └── <accountId>.context-tokens.json        # { "<userId>": "<contextToken>" }
│   └── debug-mode.json                            # { accounts: { "<id>": true } }
├── credentials/
│   └── openclaw-weixin-<accountId>-allowFrom.json # 配对白名单（framework 读）
├── tmp/                                           # resolvePreferredOpenClawTmpDir
│   ├── openclaw-YYYY-MM-DD.log                    # 通道日志（tslog JSON lines）
│   └── weixin/media/outbound-temp/                # 远程图片下载缓存
└── agents/<id>/agent/auth-profiles.json           # 模型 auth（不是通道的）
```

`resolveStateDir()` 优先级：
1. `OPENCLAW_STATE_DIR`
2. `CLAWDBOT_STATE_DIR`（旧名兼容）
3. `~/.openclaw`

---

## 10. 启动时间线（一个账号）

```
T0   openclaw gateway start
       ↓ 扫描 channels.openclaw-weixin (从 openclaw.json + accounts.json)
T1   对每个 account 调 gateway.startAccount(ctx)
       ├ assertHostCompatibility (在 register 阶段已过)
       ├ restoreContextTokens
       ├ setStatus(running: true)
       ├ notifyStart (best-effort)
       └ dynamic import monitor
            └ monitorWeixinProvider
                ├ load syncbuf from disk
                ├ WeixinConfigManager(empty)
                └ loop:
                    ├ getUpdates(long-poll)
                    │   ├ resp.ret != 0
                    │   │   ├ errcode === -14 → pauseSession(1h)
                    │   │   └ else → backoff 30s after 3 fails
                    │   ├ resp.ret == 0
                    │   │   ├ save syncbuf
                    │   │   └ for each msg: processOneMessage
                    │   │       ├ slash command?
                    │   │       ├ download media → saveMediaBuffer
                    │   │       ├ command auth
                    │   │       ├ resolveAgentRoute
                    │   │       ├ recordInboundSession
                    │   │       ├ set contextToken
                    │   │       ├ typing: start
                    │   │       ├ createReplyDispatcherWithTyping
                    │   │       ├ withReplyDispatcher
                    │   │       │   └ dispatchReplyFromConfig
                    │   │       │       └ AI runs → deliver(text/media)
                    │   │       │           ├ markdown filter
                    │   │       │           ├ message_sending hook
                    │   │       │           ├ sendMessageWeixin
                    │   │       │           │   or upload + sendXxxWeixin
                    │   │       │           └ message_sent hook (fire-forget)
                    │   │       └ typing: stop
                    │   │       └ on error: sendWeixinErrorNotice
                    │   └ update lastEventAt / lastInboundAt
                    └ next loop iteration

T2   openclaw gateway stop
       ├ 对每个 account 调 gateway.stopAccount
       │   └ notifyStop
       └ 抛 AbortSignal 给 monitor（带 inflight getUpdates 一起断）
```

---

## 11. 关键设计 trade-offs（要"读出味道"的部分）

1. **Token 与配置分离** — `openclaw.json` 不存 token（`WeixinConfigSchema` 只放 name/enabled/baseUrl/cdnBaseUrl/routeTag）；token 单独落在 `accounts/<id>.json` 并 `chmod 600`。这跟 OpenClaw 的 `~/.openclaw/credentials/` 风格一致。
2. **账号 ID 双形态** — 微信给的是 `xxx@im.bot`、`xxx@im.wechat`，文件名不能含 `@`/`.`，于是归一化成 `xxx-im-bot` / `xxx-im-wechat`，但读盘时再 `deriveRawAccountId` 退回旧名，跨版本无缝升级（`src/auth/accounts.ts:25-33`）。
3. **长轮询 + AbortSignal 联动** — gateway 停 channel 时不能等 35s 长轮询自己超时，否则 channel stop 5s budget 超了、`Monitor` 进入"停且不再起"的状态。插件把 `ctx.abortSignal` 直接合进 `fetch` 的 `AbortController`，立即打断（`monitor.ts:99-105`）。
4. **`session_expired` 一小时冷却** — 微信后端会丢 -14 让客户端别高频打。插件用进程内 `Map<accountId, until>` 做闸门，期间所有出站 `assertSessionActive` 直接拒。一小时后再放行。
5. **lazy import `monitor`** — `channel.ts:451` 显式 `await import("./monitor/monitor.js")`。注释解释：`monitor → process-message → command-auth` 整条链不要在 `register` 阶段 eager 进内存，免得 provider registry 解析时被这条链反过来钩。
6. **每个 media 单独发** — `sendMediaItems` 里 text caption + media item **不合并**进同一个 `item_list`，而是一条请求一个 item。原因推测是微信后端对混合 `item_list` 处理不稳；插件在 `send.ts:94-140` 明确写"each item is sent as its own request"。
7. **contextToken 必须 echo** — 每条出站都要把上次的 `context_token` 带回去。`processOneMessage` 末尾 `setContextToken`；`sendText/sendMedia` 入口 `getContextToken(accountId, to)`；reply dispatcher 内部 `getContextTokenFromMsgContext`。
8. **marking `X-WECHAT-UIN` 为每个请求一个随机 uint32** — `api/api.ts:222-224`，请求级的客户端 ID，跟 base64 token 走。
9. **`sanitizeBotAgent` 强 UA 语法** — `bot_agent` 字段影响后端日志归因，但格式非法时静默降级到默认 `"OpenClaw"`，永不让请求因这个字段挂掉。
10. **Markdown 流式过滤** — 微信客户端不支持粗斜体套 CJK、不支持 H5/H6、不支持 `![]()`。`StreamingMarkdownFilter` 是字符级状态机，边收边吐，只在必要边界保留 1-2 字符（`markdown-filter.ts`）。

---

## 12. 测试与扩展点

- `vitest run --coverage` —— 全模块单测（`*.test.ts` 与源码同目录），重点：`api.test.ts`、`messaging/inbound.test.ts`、`messaging/send.test.ts`、`auth/pairing.test.ts`、`cdn/cdn-upload.test.ts`、`util/redact.test.ts`。
- `silk-wasm` 软依赖：转码失败回落到 `audio/silk`，不阻断。
- 运行时新增一个端点：在 `src/api/api.ts` 加 `xxx` 导出函数 + 在 `src/api/types.ts` 加类型 + 在 monitor / send 链路调用。
- 新增 Outbound 媒体类型：扩展 `sendMediaItems`（`send.ts`）和 `sendWeixinMediaFile`（`send-media.ts`），再加一个 `UploadMediaType.XXX`。
- 想要更强的鉴权（比如群支持）需要改：
  - `capabilities.chatTypes: ["direct", "group"]`；
  - `resolveAgentRoute` 的 `peer.kind` 切到 `"group"`；
  - `dmPolicy` 不再用 `"pairing"`，要换成 group policy（`openclaw/plugin-sdk/command-auth` 有相应 helper）。

---

## 13. 一句话总结

`openclaw-weixin` 是一个**完全用 OpenClaw 公开 SDK 写就的外部通道插件**：
- `index.ts` → `registerChannel(weixinPlugin)`；
- `weixinPlugin: ChannelPlugin` 实现 `config / outbound / gateway / auth.login / status / messaging / agentPrompt / streaming` 八个面；
- gateway 把 `ctx.channelRuntime` 注入；`monitor` 拉起 `getUpdates` 长轮询循环；
- 每条入站 `processOneMessage` → `downloadMediaFromItem` → `weixinMessageToMsgContext` → `resolveSenderCommandAuthorizationWithRuntime` → `resolveAgentRoute` → `recordInboundSession` → `createReplyDispatcherWithTyping` → `withReplyDispatcher(dispatchReplyFromConfig)`；
- 媒体用 `getUploadUrl` 拿预签名 → AES-128-ECB 加密 → `POST` 上 CDN → `MessageItem` 带加密引用回送；
- 出站也走框架的 `message_sending / message_sent` 钩子；
- 所有 token 落 `accounts/<id>.json`（600 权限），所有 syncbuf / contextToken / debug mode 落 `~/.openclaw/openclaw-weixin/`；
- 出错通过 `session-guard`（-14 = 1h 冷却）、`consecutiveFailures`（3 次退避 30s）、`abortSignal`（gateway stop 时硬切）三道闸门托底。
