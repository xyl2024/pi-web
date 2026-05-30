# Pi 依赖升级指南

## 版本策略

- **精确锁定版本**（见 `package.json`），不使用 `^` / `~` 范围。
- 升级是有意识的决策，不会因为 `npm install` 意外浮到新版本。
- 所有 pi 开头的包升级时保持同一版本号 — 它们是 monorepo，版本号同步发布。

## 升级前

1. 查阅 [pi releases](https://github.com/earendil-works/pi/releases)，看 release notes 中的 breaking changes。
2. 关注和本项目直接相关的部分：session 文件格式、RPC 接口、ToolCall 结构。

## 升级步骤

```bash
# 1. 安装新版本（精确锁定）
npm install @earendil-works/pi-ai@<version> \
            @earendil-works/pi-coding-agent@<version> \
            --save-exact

# 2. typecheck
node_modules/.bin/tsc --noEmit

# 3. lint
node node_modules/.bin/next lint

# 4. 手动冒烟测试
npm run dev  # http://localhost:30141
```

## 冒烟测试检查项

- [ ] 新建 session 并发送消息
- [ ] 消息流式显示正常
- [ ] Fork session（fork 后原 session 仍可继续使用）
- [ ] In-session 分支切换（Continue 按钮 / BranchNavigator）
- [ ] 文件查看器正常
- [ ] Session sidebar 树展示正常

## 回滚

如果升级后出现兼容性问题，回滚到上一个已知正常版本：

```bash
npm install @earendil-works/pi-ai@<last-good-version> \
            @earendil-works/pi-coding-agent@<last-good-version> \
            --save-exact
```

因为只改了 `node_modules` 和 `package.json`/`package-lock.json`，回滚零副作用。

## 关注的风险点

| 耦合点 | 说明 |
|---|---|
| `.jsonl` session 文件格式 | pi 升级可能改字段名/结构，`lib/normalize.ts` 的规范化逻辑可能失效 |
| ToolCall 格式 | `normalizeToolCalls()` 处理 `{id,name,arguments}` ↔ `{toolCallId,toolName,input}` 映射 |
| `AgentSession` RPC 方法 | `rpc-manager.ts` 调用的 `session.prompt()`、`session.fork()` 等 |
| `parentSession` header | 影响 sidebar 树展示 |

## 历史版本记录

| 版本 | 日期 | 备注 |
|---|---|---|
| 0.75.5 | — | 初始版本 |
| 0.78.0 | 2026-03-26 | 升级，验证通过 |
