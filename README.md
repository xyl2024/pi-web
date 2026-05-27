# pi-web

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的网页界面。在浏览器中浏览会话、与智能体对话、分叉对话、切换消息分支。

## 快速开始

**无需安装，直接运行：**

```bash
npx @agegr/pi-web@latest
```

**或全局安装后使用：**

```bash
npm install -g @agegr/pi-web
pi-web
```

启动后打开 [http://localhost:30141](http://localhost:30141)。

**可选参数：**

```bash
pi-web --port 8080               # 自定义端口
pi-web --hostname 127.0.0.1      # 仅本机访问
pi-web -p 8080 -H 127.0.0.1     # 组合使用

PORT=8080 pi-web                 # 也支持环境变量
```

## 功能介绍

- **会话浏览器** — 按工作目录分组展示所有 pi 会话
- **实时对话** — 通过 SSE 流式输出与智能体实时交互
- **会话分叉** — 从任意用户消息创建独立的新会话分支
- **会话内分支** — 回退到任意节点继续对话，在同一文件内创建分支
- **分支导航器** — 可视化切换同一会话内的各个分支
- **模型切换** — 对话中途随时切换模型
- **工具面板** — 控制智能体可使用的工具
- **压缩会话** — 对长会话进行摘要，节省上下文窗口
- **引导 / 追加** — 打断正在运行的智能体，或在其完成后追加消息

## 注意事项

- **数据目录** — 默认读取 `~/.pi/agent/sessions` 下的会话文件。可通过环境变量 `PI_CODING_AGENT_DIR` 指定其他目录。
- **模型配置** — 从智能体数据目录下的 `models.json` 读取可用模型，可在侧边栏的「Models」面板中编辑。
- **文件浏览** — 侧边栏内置文件浏览器，可在标签页中查看当前工作目录下的文件。

## 开发

```bash
npm install
npm run dev   # 端口 30141
```

## 后端日志

pi-web 后端日志会同时输出到启动进程的终端，并追加写入日志文件。

默认日志文件：

```bash
~/.pi-web/logs/pi-web-YYYY-MM-DD.log
```

可用环境变量调整：

```bash
PI_WEB_LOG_LEVEL=debug npm run dev              # debug/info/warn/error
PI_WEB_LOG_FILE=/tmp/pi-web.log npm run dev     # 指定日志文件基名，实际写入 /tmp/pi-web-YYYY-MM-DD.log
PI_WEB_LOG_DIR=/tmp/pi-web-logs npm run dev     # 指定日志目录，实际写入该目录下 pi-web-YYYY-MM-DD.log
PI_WEB_LOG_FILE=off npm run dev                 # 关闭文件日志，仅输出终端
```

Docker Compose 默认将 `/home/node` 挂载为 volume，容器内默认日志路径为：

```bash
/home/node/.pi-web/logs/pi-web-YYYY-MM-DD.log
```

查看 Docker 日志：

```bash
docker compose logs -f pi-web
tail -f ./volumes/pi_home/.pi-web/logs/pi-web-$(date +%F).log
```

## 宿主机部署

当前仓库的宿主机 systemd 部署记录见 [`docs/host-systemd-deployment.md`](docs/host-systemd-deployment.md)。

宿主机部署时不要用 `npm run dev` 或从项目目录长期运行服务。推荐把服务进程作为真实使用者启动，并把工作目录设为该用户的 `$HOME`，这样默认工作区、`~/.pi`、`~/.pi-web` 等路径都按宿主机用户解析。

要求：

- Node.js 22+
- 以实际使用 pi 的用户运行，例如 `alone`
- 默认数据目录为 `~/.pi/agent`；如需自定义可设置 `PI_CODING_AGENT_DIR`

本 fork 使用源码部署脚本：

```bash
scripts/deploy-systemd-user.sh
```

systemd 示例：

```ini
[Unit]
Description=pi-web
After=network.target

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=HOME=/home/alone
Environment=PI_WEB_WORKDIR=/home/alone
# 如需指定 pi 数据目录，取消下一行注释
# Environment=PI_CODING_AGENT_DIR=/home/alone/.pi/agent
WorkingDirectory=/home/alone
ExecStart=/home/alone/.local/share/pi-node/node-v22.22.3-linux-x64/bin/node /home/alone/.local/share/pi-web-fork/bin/pi-web.js --hostname 0.0.0.0 --port 30141
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-web
journalctl --user -u pi-web -f
```

## 项目结构

```
app/
  api/
    sessions/      # 读写会话文件
    agent/         # 发送命令、SSE 事件流
    files/         # 文件内容读取
    models/        # 可用模型列表与默认模型
    models-config/ # 读写 models.json
components/        # UI 组件
lib/
  session-reader.ts  # 解析 .jsonl 会话文件
  rpc-manager.ts     # 管理 AgentSession 生命周期
  normalize.ts       # 规范化 toolCall 字段名
  types.ts
```

会话文件存储路径：`~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`
