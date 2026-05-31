# start-pi-agent.ps1 — 静默启动 Pi Agent Electron 壳（开机自启用）
#
# 用法：
#   1. 右键此脚本 →「使用 PowerShell 运行」测试
#   2. 确认托盘出现 Pi Agent 图标后，创建快捷方式放入启动目录：
#      按 Win+R → shell:startup → 把此脚本的快捷方式放进去
#
# 启动目录路径（手动备用）：
#   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 定位 electron.exe
$electronExe = Join-Path $scriptDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "[Pi Agent] Electron 未找到，请先运行: cd '$scriptDir' ; npm install" -ForegroundColor Red
    exit 1
}

# 静默启动（--hidden = 窗口不显示，仅托盘图标）
Start-Process `
    -FilePath $electronExe `
    -ArgumentList $scriptDir, "--hidden" `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden

Write-Host "[Pi Agent] 已在后台启动，查看系统托盘图标" -ForegroundColor Green
