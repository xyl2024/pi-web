# 宿主机 systemd 部署记录

记录时间：2026-05-27

本文记录本次从 Docker 部署切换到宿主机 systemd 部署的实际操作，以及后续更新和排障方式。

## 目标

- 不再使用 Docker 运行 `pi-web`。
- 不使用全局安装的 `@agegr/pi-web@0.6.11`，因为那是上游版本，不包含本 fork 的改动。
- 不从项目源码目录长期运行服务，避免服务端初始工作目录识别为 `/home/alone/p/pi-web`。
- 服务运行时的 `HOME` 和工作目录都应为 `/home/alone`。

## 已完成的改动

### CLI 启动行为

修改了 `bin/pi-web.js`：

- `next start` 显式接收应用包目录，确保能找到 `.next`。
- 子进程 `cwd` 使用 `PI_WEB_WORKDIR`，没有设置时使用调用命令时的当前目录。
- 因此 systemd 可以把 `WorkingDirectory` 设置为 `/home/alone`，同时仍然从部署目录加载构建产物。

相关代码：

```js
const runtimeCwd = process.env.PI_WEB_WORKDIR || process.cwd();
const nextArgs = ["start", pkgDir, "-p", port];

const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: runtimeCwd,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env },
});
```

### README

在 `README.md` 中补充了宿主机部署说明、systemd 示例和常用命令。

### systemd user service

创建了 user service：

```text
/home/alone/.config/systemd/user/pi-web.service
```

当前服务内容使用本 fork 的部署目录：

```ini
[Unit]
Description=pi-web
After=network.target

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=HOME=/home/alone
Environment=PI_WEB_WORKDIR=/home/alone
WorkingDirectory=/home/alone
ExecStart=/home/alone/.local/share/pi-node/node-v22.22.3-linux-x64/bin/node /home/alone/.local/share/pi-web-fork/bin/pi-web.js --hostname 0.0.0.0 --port 30141
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

已执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-web.service
loginctl enable-linger alone
```

`linger` 已开启，因此用户未登录时 user service 也可以在开机后启动。

## 当前部署目录

源码工作目录：

```text
/home/alone/p/pi-web
```

生产部署目录：

```text
/home/alone/.local/share/pi-web-fork
```

部署目录是从源码工作目录同步出来的副本，然后在部署目录执行：

```bash
npm ci
npm run build
```

这样不会污染源码工作目录的 `.next/`。

## Docker 处理

之前端口 `30141` 被 Docker Compose 容器占用：

```text
pi-web-pi-web-1
```

已在项目目录执行：

```bash
docker compose down
```

该命令只停止并移除容器和 compose 网络，没有删除 volume 数据。

## 当前验证结果

服务状态：

```bash
systemctl --user show pi-web.service -p ActiveState -p SubState -p MainPID -p NRestarts --no-pager
```

结果为：

```text
ActiveState=active
SubState=running
NRestarts=0
```

HTTP 验证：

```bash
curl -I http://127.0.0.1:30141/
```

返回 `200 OK`。

HOME 验证：

```bash
curl http://127.0.0.1:30141/api/home
```

返回：

```json
{"home":"/home/alone"}
```

## 后续更新流程

每次修改 `/home/alone/p/pi-web` 后，如需让 systemd 服务使用新版本，执行：

```bash
scripts/deploy-systemd-user.sh
```

脚本会执行以下操作：

- 将当前仓库同步到 `/home/alone/.local/share/pi-web-fork/`
- 排除 `.git`、`node_modules`、`.next`、`volumes`、`tsconfig.tsbuildinfo`
- 在部署目录执行 `npm ci`
- 在部署目录执行 `npm run build`
- 重启 `pi-web.service`

确认状态：

```bash
systemctl --user status pi-web
curl -I http://127.0.0.1:30141/
```

## 常用命令

查看服务：

```bash
systemctl --user status pi-web
```

重启服务：

```bash
systemctl --user restart pi-web
```

停止服务：

```bash
systemctl --user stop pi-web
```

查看日志：

```bash
journalctl --user -u pi-web -f
```

查看端口占用：

```bash
ss -ltnp 'sport = :30141'
```

确认没有 Docker 版本占用端口：

```bash
docker ps --format '{{.ID}} {{.Names}} {{.Ports}}' | rg '30141|pi-web'
```

## 注意事项

- 不要再用全局 `pi-web` 命令作为该服务入口，除非确认全局包就是本 fork 构建出来的版本。
- 不要直接从 `/home/alone/p/pi-web` 长期运行生产服务；使用部署副本 `/home/alone/.local/share/pi-web-fork`。
- 开发目录避免执行 `next build`，生产构建放到部署目录执行。
- 如果端口启动失败，优先检查是否有旧 Docker 容器、手动 `npm run dev` 或其他 `next-server` 占用了 `30141`。
