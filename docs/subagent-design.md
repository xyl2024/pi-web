# Subagent 设计

> 状态：探索 / 设计阶段。已调研、未实施。
> 目的：让 pi-web 的 agent 能通过工具调用把任务委派给"子 agent"（隔离上下文、不同 model/工具子集），对齐 Claude Code / Codex 的 subagent 体验。

---

## 1. 背景：Claude Code / Codex 的 subagent 模型

两个产品的核心抽象高度一致：

1. **Agent 定义文件**：带 YAML frontmatter 的 markdown
   - `name` / `description`：父模型据此决定何时调用
   - `model`：可与父 agent 不同（典型分层：Haiku 做 scout，Sonnet/Opus 做 worker）
   - `tools`：父工具的子集（scout 只读；worker 全套）
   - body：system prompt
2. **调用入口**：父 agent 通过工具调用 dispatch（Claude Code 的 `Task` tool、Codex 的 spawn），由 LLM 决定何时拆任务
3. **三种调用模式**：
   - `single` — `{ agent, task }`
   - `parallel` — `{ tasks: [{ agent, task }, ...] }`，常见上限 8 任务 / 4 并发
   - `chain` — `{ chain: [...] }`，用 `{previous}` 占位符把上一步输出传给下一步
4. **隔离 context window**：每个 subagent 拿独立上下文；摘要回吐给父 agent，父不被中间过程污染

关键不变式：sub-agent 必须能读父的 `cwd` / `AGENTS.md` / 系统提示的一部分，否则做不了有意义的 recon。Claude Code 把 `parentSessionPath` 写进子 session 文件头就是为此。

---

## 2. 上游参考实现

`@earendil-works/pi-coding-agent`（pi-web 已经在用）自带 `examples/extensions/subagent/`，是上游团队的官方参考实现。要点：

| 维度 | 上游做法 |
|---|---|
| Agent 定义位置 | `~/.pi/agent/agents/*.md`（user）+ `.pi/agents/*.md`（project，靠 `agentScope` 开关） |
| 执行方式 | 每个 subagent = 一个独立 `pi --mode json -p --no-session` 子进程；通过 `--append-system-prompt <tmp.md>` 注入该 agent 自己的 system prompt |
| 流式进度 | 父扩展解析 JSON 事件流，`onUpdate` 回调让父 LLM 实时看到 subagent 的 tool call / 文本 |
| Abort | 把父 `signal` 绑到 `proc.kill("SIGTERM")`（5s 后升级 `SIGKILL`） |
| 输出截断 | parallel 模式按 50KB / 任务截断返回给 LLM；完整结果保留在 tool `details` |
| 上限 | max 8 并发任务、4 并发 |

**与 pi-web 的不契合点**：

1. **子进程开销**：每个 subagent 都重新走 model 鉴权 / registry 加载；pi-web 已经有 `startRpcSession()` 在同一 Node 进程内建 `AgentSession`，零开销。
2. **二进制依赖**：依赖系统装好 `pi` CLI；pi-web 用户未必装。
3. **TUI-only 渲染**：上游扩展的 `renderCall`/`renderResult` 用 `@earendil-works/pi-tui`；pi-web 前端是 React，subagent 进度会被当成普通 toolCall/toolResult 渲染（不是坏事，但缺专属观感）。

---

## 3. pi-web 现状盘点

只列与 subagent 直接相关的部分（详细见 CLAUDE.md + `lib/rpc-manager.ts` / `hooks/useAgentSession.ts` / `lib/session-reader.ts`）。

| 维度 | 现状 |
|---|---|
| 会话生命周期 | 一个 session 一个 `AgentSessionWrapper`，注册到 `globalThis.__piSessions`；10 分钟 idle 后 `destroy()`；并发启动用 `__piStartLocks` 串行化 |
| HTTP 入口 | `POST /api/agent/new`（创建）；`POST /api/agent/[id]`（13 种命令：`prompt` / `fork` / `navigate_tree` / `set_model` / `set_tools` / `compact` 等）；`GET /api/agent/[id]/events`（SSE，30s 心跳） |
| 已有"父子 session"概念 | `fork` 命令（`lib/rpc-manager.ts:244-286`）—— **父 wrapper 在 fork 后立刻销毁**，新 session 写 `parentSession` header，侧栏按 `parentSessionId` 显示树形 |
| Frontend 状态 | `useAgentSession` 聚合 SSE 事件；UI 表面：`ChatWindow` / `ChatInput` / `SessionSidebar` / `TabBar` |
| "工具正在跑"指示 | `agentPhase`：`{ kind: "waiting_model" }` / `{ kind: "running_tools", tools: [...] }`，在 ChatWindow 顶部 |
| subagent 代码 | **无**。`lib/agent-todo-tool.ts:62` 有个 `owner: "Owning agent or sub-agent name."` 字段占位，但调用链未实现 |
| 扩展加载 | `startRpcSession` 用 `DefaultResourceLoader` 配合内联扩展工厂，`additionalExtensionPaths` 走 `jiti.import`（必须是文件路径，不是目录） |

**关键洞见**：pi-web 已经有完整的"开第二个 AgentSession + 流式推消息"基础设施，所以 subagent 完全可以在**进程内**跑，不必走子进程路线。

---

## 4. 设计目标（YAGNI 版）

- 一个 `subagent` tool，LLM 可调用；支持 single / parallel / chain 三种模式
- 每个 subagent 是同一 Node 进程内的一个新 `AgentSessionWrapper`
- **父 wrapper 不销毁**（与 `fork` 不同）；subagent 跑完后，父 wrapper 拿到结果摘要作为 tool result
- Agent 定义从 `~/.pi-web/agents/*.md` 读（与上游 `~/.pi/agent/agents/*.md` 同构，可直接复用上游 scout/planner/reviewer/worker markdown）
- 协议层先打通；前端实时进度面板留白到真有需求再做

---

## 5. 三层结构

```
浏览器 (React)
  │  ChatInput / ChatWindow
  │
  ▼  SSE  ←  /api/agent/[parentId]/events
  │
Next.js Server (rpc-manager.ts)
  │
  ├── AgentSessionWrapper (parent, 已有)
  │     │  收到 subagent tool call
  │     │  → 在进程内调 startRpcSession() 开第二个 wrapper
  │     ▼
  └── AgentSessionWrapper (subagent, 新建)
        │  复用同样的 SSE / payload / auth / wrapper 事件总线
        ▼
      createAgentSession()  ←  pi-coding-agent SDK
```

---

## 6. 实施步骤（最小可用版）

### Step 1 — wrapper 加 `awaitPrompt(text, opts?)`

`startRpcSession(sessionId, sessionFile, cwd, toolNames)` 已支持 `sessionFile === ""` 走 `SessionManager.create`。subagent 不需要用户交互，纯 prompt 完拿结果即可。

新增方法语义：
- 注入 systemPrompt（用 `SessionManager.appendMessage` 或 `set_system_prompt`，看 SDK 暴露哪个）
- 调 `prompt(text)` 触发一轮
- 等到 `isStreaming === false` 且 `agent_end` 已发
- 返回 `{ messages, usage, stopReason }`
- wrapper 进入正常 10 分钟 idle 倒计时，最后被 GC

位置：`lib/rpc-manager.ts`，约 30 行。

### Step 2 — 扩展文件 `extensions/subagent/index.ts`

参考 `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`，但**替换 `spawn()` 调用**为对 pi-web server 内部 fetch（同进程内调用，不走 HTTP）：

- 工具签名：`{ agent?, task?, tasks?, chain?, agentScope?: "user" }`
- 参数校验：必须恰好命中 single / parallel / chain 之一
- agent 加载：从 `~/.pi-web/agents/` 解析 YAML frontmatter，得到 `{ name, description, model, tools?, systemPrompt }`
- agentScope 只支持 `"user"`；`"project"` / `"both"` 一律拒绝（避免权限确认 UI；与上游的 `confirmProjectAgents` 不同）

预计 ~150 行（包含 single + parallel + chain 三种模式的分发、错误处理、abort 绑定）。

### Step 3 — 内部 endpoint `app/api/_subagent/route.ts`

下划线开头：仅 server-internal 暴露，外部 HTTP 不应直连（可以加一条中间件按 `Referer` 校验，或干脆挂到 `instrumentation.ts` 启动的内部 server 上；最简方案是放在 `app/api/_subagent/`，依赖路径前缀做软隔离）。

POST body：`{ parentSessionId, agentConfig, task }`

流程：
1. 校验 `agentConfig`（必须有 `name` + `systemPrompt`）
2. `startRpcSession("__sub__<uuid>", "", cwd, agentConfig.tools ?? "all")` 拿到新 wrapper
3. 通过 `awaitPrompt()` 跑一轮
4. 把结果 JSON 返回给 Step 2 的 fetch 调用方
5. 错误路径：abort / 非零退出码 → 返回 `isError: true`，由上游扩展决定是否再投递给 LLM

预计 ~80 行。

### Step 4 — `rpc-manager.ts` 注册扩展

把 `extensions/subagent/index.ts` 加进 `startRpcSession` 已有的 `DefaultResourceLoader` 工厂的 `additionalExtensionPaths` 数组（一行改动）。

注意：`additionalExtensionPaths` 走 `jiti.import`，**必须传文件路径**而非目录（参考已有踩坑记录）。

### Step 5 — Frontend：**先不做**

把 subagent toolCall / toolResult 当普通 tool 渲染即可——`MessageView` 已经支持。

真正需要补的是"subagent live 进度面板"（显示并行跑的 N 个 child 的当前状态），但这一步：

- 等 Step 1-4 上线、用户跑过真实场景、反馈"看不到进度"再做
- 与 CLAUDE.md 第 2 条「Simplicity First」一致：不被要求就不做

### Step 6 — Agent 定义文件

- 默认 `~/.pi-web/agents/`（user 级）
- fallback 到 `~/.pi/agent/agents/`（与上游共享，让上游 scout/planner/reviewer/worker markdown 直接可用）
- 仓库内不自带示例；用户在文档里看到 4 个上游 markdown 的存在位置与如何拷贝即可

---

## 7. 与 Claude Code / Codex 的对比

| 维度 | Claude Code / Codex | 本方案 |
|---|---|---|
| Agent 定义 | markdown + YAML | 同 |
| 调度模型 | LLM 通过 tool 调 | 同（tool 名 `subagent`） |
| 三种模式 | single / parallel / chain | 同 |
| 隔离 context | 独立 session（sub-process） | 独立 session（in-process wrapper） |
| Streaming 进度 | 父 tool 实时显示 | Phase 1：最后一次性回吐；Phase 2：SSE 透传 subagent 事件到 React |
| 并发 | 8 任务 / 4 并发 | Phase 1：复用 `__piStartLocks` 串行（实现最简）；Phase 2：多 wrapper 并发 + 多 SSE 通道 |
| Abort | 子进程 SIGTERM/SIGKILL | wrapper `inner.abort()`，clean |

---

## 8. 明确不做的事

- ❌ 前端 subagent 进度面板（Phase 5 留白）
- ❌ subagent 调用 subagent 的多层嵌套 UI（机制上自然支持，不暴露）
- ❌ `agentScope: "project"` / `.pi/agents/` 扫描（避免权限确认 UI 的复杂度）
- ❌ `confirmProjectAgents`（同上游 TUI 的 dialog，pi-web 没有等价物）
- ❌ output truncation / markdown rendering / usage 统计 UI（subagent 返回纯文本 + JSON `details`，前端 MessageView 自行处理）

核心原则：先把"LLM 能调 subagent、跑完拿结果"主路径打通，再考虑观感。

---

## 9. 待定项

1. **方案范围**：是直接做 Phase 1（Step 1-4 + 6，估 ~250 行），还是先用"装上游 subagent 扩展"做 0 号方案快速验证（10 分钟，但有子进程开销 + `pi` 二进制依赖）？
2. **Agent 定义目录**：用 `~/.pi-web/agents/` 还是 `~/.pi/agent/agents/`？倾向后者（与上游共享，可直接复用 scout/planner markdown），fallback 前者。
3. **并发**：Phase 1 串行（`__piStartLocks` 自然串行化）；真并行（多 wrapper 同时跑）放到 Phase 2，按需触发。

---

## 10. 关键文件清单（实施时改动）

| 文件 | 改动 |
|---|---|
| `lib/rpc-manager.ts` | 加 `AgentSessionWrapper.awaitPrompt()`；把 `extensions/subagent/index.ts` 加入 `additionalExtensionPaths` |
| `extensions/subagent/index.ts` | **新建**；扩展入口 + 三种模式分发 |
| `app/api/_subagent/route.ts` | **新建**；server-internal 入口 |
| `docs/subagent-design.md` | 本文 |
| `hooks/useI18n.tsx` | 若 Phase 2 加前端面板时需要新增 i18n key |
| （待定）`components/SubagentPanel.tsx` | Phase 2 用，先不写 |

---

## 11. 参考

- 上游参考：`node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`
- 上游 Agent 模板：`.../subagent/agents/{scout,planner,reviewer,worker}.md`
- 上游工作流 prompt：`.../subagent/prompts/{implement,scout-and-plan,implement-and-review}.md`
- pi-coding-agent 扩展机制：`.../docs/extensions.md`
- pi-web 会话/扩展桥接：`lib/rpc-manager.ts`、`lib/normalize.ts`
