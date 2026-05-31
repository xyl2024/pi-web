# start-pi-agent.ps1
# Launch Pi Agent Electron shell silently (for Windows startup)
#
# Test manually first:
#   Right-click this file -> Run with PowerShell
#
# Then add to startup:
#   Win+R -> shell:startup -> drop a shortcut to this script

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$electronExe = Join-Path $scriptDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "[Pi Agent] electron.exe not found. Run: cd '$scriptDir' ; npm install" -ForegroundColor Red
    exit 1
}

Start-Process `
    -FilePath $electronExe `
    -ArgumentList $scriptDir, "--hidden" `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden

Write-Host "[Pi Agent] Started in background — check the system tray" -ForegroundColor Green
