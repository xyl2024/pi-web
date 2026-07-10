# Inbox 消息中心 — 协议与接入指南

> 跨模块的"侧通道"统一通知收件箱。任何 server-side 模块都可以往里推一条消息，用户在一个全屏模态里集中浏览/清空/删除。
>
> **不动 RSS、Scheduler、Todo 等各自原有的"未读"机制**——Inbox 是补充而非替代。

---

## 1. 数据流

```
[server 推送源]  pushMessage()        [前端]                 [UI]
                       ↓                 ↓                     ↓
                lib/inbox-store     /api/inbox/messages   InboxBell (badge)
                       ↓                 ↓                     ↓
                ~/.pi-web/inbox.db   GET / DELETE          InboxModal (5s 轮询)
```

- **写入**：推送源 `import { pushMessage } from "@/lib/inbox-store"` → SQLite（`~/.pi-web/inbox.db`，可用 `PI_WEB_INBOX_DB` 覆盖）
- **读取**：
  - 铃铛 badge：30s 轮询 `?limit=500`，返回的消息总数即 badge 数字（消息清空后下次轮询归零）
  - 模态列表：5s 轮询 `?limit=200`（仅模态打开时挂载定时器，关闭即卸载）
- **删除**：单条 / 全部 / 按 source / 7 天前 — 全部走 `DELETE /api/inbox/messages` 加查询参数

---

## 2. 协议 Schema

源文件：`lib/inbox-schema.ts`

```ts
export type InboxLevel = "info" | "warn" | "error";
export const INBOX_LEVELS = ["info", "warn", "error"] as const;

export interface InboxMessage {
  id: string;                  // UUID，server 端 pushMessage 生成
  ts: number;                  // epoch ms，server 端 pushMessage 写 Date.now()
  source: string;              // "rss" | "scheduler" | ... 推送源标识
  level: InboxLevel;           // 决定左边色条配色
  title: string;               // 必填，≤ 300 字符
  payload?: Record<string, unknown>;  // 开放逃生舱，body/href 等自定义字段
}

export interface InboxPushInput {
  source: string;              // 必填，≤ 64 字符
  level?: InboxLevel;          // 缺省 "info"
  title: string;               // 必填，≤ 300 字符
  payload?: Record<string, unknown>;  // 序列化后 ≤ 16KB
}
```

### payload 约定

`payload` 是开放逃生舱；目前约定的标准字段是：

| 字段   | 类型   | 渲染行为                                                                 |
|--------|--------|--------------------------------------------------------------------------|
| `body` | string | 显示在 title 下方的小字说明（`<div>`，`whiteSpace: pre-wrap`）            |
| `href` | string | 包住 title 的 `<a target="_blank" rel="noreferrer">`（外链跳转）          |

`InboxMessageRow` 对 `body` / `href` 之外的 payload 字段不感知。如需扩展（图标、操作按钮、code block 等），请同时改 `InboxMessageRow`。

### 校验

| 字段       | 限制                                  | 失败 → `InboxValidationError.field` |
|------------|---------------------------------------|--------------------------------------|
| `source`   | 必填，trim 后 1–64 字符               | `source`                             |
| `level`    | 缺省 `info`；大小写不敏感但必须 ∈ 集合 | `level`                              |
| `title`    | 必填，trim 后 1–300 字符              | `title`                              |
| `payload`  | object（不能是 array），序列化 ≤ 16KB  | `payload`                            |

所有校验失败抛 `InboxValidationError`，路由层统一映射为 400 + `{ error, field }`。

### 错误类

```ts
export class InboxValidationError extends Error {
  public readonly field: string;  // "source" | "level" | "title" | "payload"
  constructor(field: string, message: string);
}
```

---

## 3. HTTP API

### `GET /api/inbox/messages`

| Query         | 类型      | 含义                                                  |
|---------------|-----------|-------------------------------------------------------|
| `since=<ms>`  | number    | 只返回 `ts > since` 的消息（铃铛 badge 用）           |
| `source=<s>`  | string    | 只返回该 source 的消息                                |
| `limit=<n>`   | number    | 最大 1000，默认 500                                   |
| `sourcesOnly` | `"1"`     | 返回 `{ sources: [{ source, count }, ...] }` 而非消息 |

返回：`{ messages: InboxMessage[] }` 或 `{ sources: [{ source, count }] }`

### `DELETE /api/inbox/messages`

| Query            | 行为                                  | 返回                              |
|------------------|---------------------------------------|-----------------------------------|
| `all=1`          | 清空全部                              | `{ ok: true, deleted: N }`        |
| `source=<s>`     | 删除该 source 的全部消息              | `{ ok: true, deleted: N, source }` |
| `olderThan=<ms>` | 删除 `ts < ms` 的全部消息             | `{ ok: true, deleted: N, olderThan }` |

三选一；都不传 → 400。

### `POST /api/inbox/test` — 故意留的"测试专用"端点

源文件：`app/api/inbox/test/route.ts`

`/api/inbox/messages` 故意**不**实现 POST（注释见 `app/api/inbox/messages/route.ts:17-20`）——"push is server-side only, driven by lib/inbox-store.pushMessage() from the rss loop / scheduler runner / etc."。客户端不能任意写。

但 Settings → "Inbox Test" section 需要从 UI 推一条模拟消息给开发者自测；它的实现是新增了**独立的** `POST /api/inbox/test` 路由（仍由 Next.js server 端执行，调用同一个 `pushMessage`），**不动** `messages` 路由的 POST 护栏。这条规则给后续模块做对接测试时也是同样的入口。

请求体：

```ts
{ source: string, level?: "info"|"warn"|"error", title: string,
  body?: string, href?: string }
```

返回：`{ ok: true, message: InboxMessage }`（201）

---

## 4. 存储

源文件：`lib/inbox-store.ts`（CRUD）/ `lib/inbox-db.ts`（SQLite 单例）

- **表**：`inbox_messages(id PK, ts, source, level, title, payload_json)`
- **索引**：`idx_inbox_messages_ts (ts DESC)` + `idx_inbox_messages_source_ts (source, ts DESC)`
- **单例**：通过 `globalThis.__piInboxDb` 防止 Next.js dev HMR 重复打开句柄（与 `lib/scheduler-db.ts` / `lib/http-collections-db.ts` 同样的模式）
- **WAL + synchronous = NORMAL**：高频插入友好
- **环境变量**：`PI_WEB_INBOX_DB` 覆盖默认路径 `~/.pi-web/inbox.db`

### 关键 API

```ts
pushMessage(input: InboxPushInput): InboxMessage       // insert
listMessages(opts?: { since?, source?, limit? }): InboxMessage[]
countMessages(): number
deleteByIds(ids: string[]): number
deleteAll(): number
deleteBySource(source: string): number
deleteOlderThan(ts: number): number
listSources(): Array<{ source: string; count: number }>
```

> **append-only**：Inbox 在协议层不更新消息；只能 push / delete。

---

## 5. UI 架构

### 入口
- **InboxBell** (`components/InboxBell.tsx`)：左下角 28×28 铃铛，红点 badge（>99 显示 "99+"），跟 Settings 齿轮同款 Tooltip
- **InboxModal** (`components/InboxModal.tsx`)：全屏 `position: fixed; zIndex: 1000` overlay

### 顶部工具栏
- Clear older than 7 days / Clear all / × 关闭

### source 计数 chip
顶部横排，每个 source 一个 chip（按消息数倒序）；点击 → `useConfirm()` 二次确认 → `DELETE ?source=<s>`

### 消息列表
- `4px` 左边色条（按 level 配色）
- `source` 大写 + 相对时间（just now / Xm ago / Xh ago / Xd ago）
- 标题（有 `href` 时包成 `<a target="_blank">`）
- body（`whiteSpace: pre-wrap`）
- 关闭模态不修改 badge：消息还在就继续显示实际数量，仅在消息被清掉后下次轮询才归零

### 底部状态行
`{n} messages · Auto-refresh every 5s`

### 轮询节奏
| 组件              | 间隔  | URL                                | 触发条件                |
|-------------------|-------|------------------------------------|-------------------------|
| `useInboxUnreadCount` | 30s | `?limit=500`                       | AppShell mount，常驻     |
| `useInbox`            | 5s  | `?limit=200`                       | 模态打开，关闭即卸载     |

---

## 6. Level 配色

`InboxMessageRow` / `InboxTestSection` 共用：

| level  | 颜色                  |
|--------|-----------------------|
| `info` | `var(--text-muted)`（灰） |
| `warn` | `#f59e0b`（橙）        |
| `error`| `#ef4444`（红）        |

---

## 7. 当前推送源

| source     | level      | 触发位置                       | 备注                                                                 |
|------------|------------|--------------------------------|----------------------------------------------------------------------|
| `rss`      | `info`     | `lib/rss/loop.ts:100`          | `fetchAndRefreshFeed` 成功且 `inserted > 0`；body = "N new articles" |
| `scheduler`| `error`    | `lib/scheduler/runner.ts:65-75`| cwd 缺失                                                              |
| `scheduler`| `info`     | `lib/scheduler/runner.ts:109-114` | 成功；body = `reply.slice(0, 200)`                                  |
| `scheduler`| `warn`/`error` | `lib/scheduler/runner.ts:122-127` | 失败/超时；body = `errorStr.slice(0, 200)`                       |

调度器的三个出口都包在 `safePush()` 里，try/catch + `log.warn`，**Inbox 推送失败绝不能污染主流程**（注释见 `lib/scheduler/runner.ts:39-50`）。RSS 循环同样用 try/catch 隔离（`lib/rss/loop.ts:101-116`）。

---

## 8. 接入新推送源 — Checklist

要把某个 server-side 模块接入 Inbox：

1. **决定 `source` 标识**：用模块名小写字符串（`rss` / `scheduler`），保持稳定，用户清空时按这个 key 删
2. **决定 `level`**：
   - 普通状态变更 → `info`
   - 性能/超时/重试可恢复问题 → `warn`
   - 致命失败/无法继续 → `error`
3. **决定 `title`**：用 `task.name` / `feed.title` 等用户能识别的字符串
4. **决定 `body`**：把详情塞进 `payload.body`（≤ 200 字符最佳，避免模态里挤）
5. **决定是否需要 `href`**：如果有点开后能看更多内容的 URL（文章页、run 详情页），塞 `payload.href`
6. **写入**：
   ```ts
   import { pushMessage } from "@/lib/inbox-store";
   // ...
   try {
     pushMessage({
       source: "your-module",
       level: "info",
       title: "...",
       payload: { body: "...", href: "https://..." },
     });
   } catch (err) {
     // Inbox 是侧通道，失败绝不能拖垮主流程
     log.warn("inbox push failed", { error: String(err) });
   }
   ```
7. **不要做的事**：
   - 不要把 `pushMessage` 直接暴露给 agent 工具（避免 agent 给自己刷消息）
   - 不要在失败路径上 `await`/`throw` 把 Inbox 错误冒泡到上游
   - 不要在 payload 里塞超过 16KB 的对象（`validatePayload` 会拒）
8. **调试**：用 Settings → "Inbox Test" section 验证 UI 渲染（badge / 列表 / source chip）是否正常

---

## 9. 测试入口

`components/InboxTestSection.tsx`（Settings 滚到底）是一个 dev-facing 表单：

- source / level（3 个色块 chip）/ title / body（可选）/ link URL（可选）
- 客户端轻校验：source 和 title 非空、href 通过 `new URL()`
- 服务端二次校验（`POST /api/inbox/test`），失败时 toast 显示 `field` + `error`
- 发送成功 → 状态行 `✓ HH:MM:SS · source · level · "title"`（持续到下次发送）
- 发送失败 → 状态行 `✗ HH:MM:SS · error`
- 表单**不**自动重置，方便连续测试不同 level / 字段

新增推送源时，先用这个 section 跑 3 条不同 level 的样本，确认 InboxModal 的色条 / body / href 渲染符合预期，再接入真实数据流。

---

## 10. 文件索引

| 路径                                  | 角色                                                  |
|---------------------------------------|-------------------------------------------------------|
| `lib/inbox-schema.ts`                 | 协议类型、校验器、错误类                              |
| `lib/inbox-store.ts`                  | CRUD（push / list / delete）                          |
| `lib/inbox-db.ts`                     | SQLite 单例 + schema                                  |
| `app/api/inbox/messages/route.ts`     | GET / DELETE（POST 故意未实现）                       |
| `app/api/inbox/messages/[id]/route.ts`| 单条 DELETE（按 id）                                  |
| `app/api/inbox/test/route.ts`         | POST — 测试专用入口                                   |
| `hooks/useInbox.ts`                   | 模态 5s 轮询                                          |
| `hooks/useInboxUnreadCount.ts`        | 铃铛 30s 轮询 + localStorage 已读水位线               |
| `components/InboxBell.tsx`            | 铃铛 + badge                                          |
| `components/InboxModal.tsx`           | 全屏模态                                              |
| `components/InboxMessageRow.tsx`      | 单条消息渲染（色条 / body / href）                    |
| `components/InboxTestSection.tsx`     | Settings 里的测试表单                                 |
| `scripts/test-inbox-test-endpoint.ts` | smoke test（6 用例：happy path / 最小 / 3 个 400 / 落库） |
