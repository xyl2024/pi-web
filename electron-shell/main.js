// main.js — Pi Agent Electron Shell
// Phase 1: window + tray + global shortcut + single-instance + manual retry

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  ipcMain,
} = require("electron");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────
const PI_PORT = process.env.PI_PORT || "14514";
const PI_URL = `http://localhost:${PI_PORT}`;

// ── CLI flags ────────────────────────────────────────────────────────
const startHidden = process.argv.includes("--hidden");

// ── State ───────────────────────────────────────────────────────────
let win = null;
let tray = null;
let isQuitting = false;

// ── App icon ─────────────────────────────────────────────────────────
const iconPath = path.join(__dirname, "pi.png");

// ── Error page (shown when Pi server is unreachable) ─────────────────
function errorPage() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
display:flex;justify-content:center;align-items:center;height:100vh;
background:#0f0f1a;color:#c8c8d0}
.container{text-align:center;max-width:400px}
h1{font-size:22px;font-weight:500;margin-bottom:12px;color:#e0e0e8}
p{font-size:14px;color:#787888;margin-bottom:6px}
button{margin-top:16px;padding:10px 24px;font-size:15px;border:none;
border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer}
button:hover{background:#3a7bc8}
</style></head><body><div class="container">
<h1>Pi 服务未连接</h1>
<p>请确保 WSL2 中 Pi Agent Web 已启动（端口 ${PI_PORT}）</p>
<button onclick="window.piShell.retry()">手动重试</button>
</div></body></html>`)}`;
}

// ── BrowserWindow ───────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: "Pi Agent",
    autoHideMenuBar: true,
    show: !startHidden,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Catch navigation failures to the Pi URL → show error page
  win.webContents.on("did-fail-load", (_event, _code, _desc, validatedURL, isMainFrame) => {
    if (isMainFrame && validatedURL === PI_URL) {
      win.loadURL(errorPage()).catch(() => {});
    }
  });

  // IPC: manual retry from error page
  ipcMain.on("retry-connection", () => {
    if (win) {
      console.log("[Pi Shell] Manual retry...");
      win.loadURL(PI_URL).catch(() => {
        win.loadURL(errorPage()).catch(() => {});
      });
    }
  });

  // Try connecting once
  console.log(`[Pi Shell] Connecting to ${PI_URL}`);
  win.loadURL(PI_URL).catch(() => {
    // Initial failure → show error page (did-fail-load will also fire)
    win.loadURL(errorPage()).catch(() => {});
  });

  // Hide to tray instead of closing
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

// ── System Tray ─────────────────────────────────────────────────────
function createTray() {
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip("Pi Agent");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示窗口",
      click: () => {
        if (win) {
          win.show();
          win.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (win) {
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
}

// ── App Lifecycle ───────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    const registered = globalShortcut.register(
      "CommandOrControl+Shift+P",
      () => {
        if (win) {
          if (win.isVisible()) {
            win.hide();
          } else {
            win.show();
            win.focus();
          }
        }
      }
    );

    if (!registered) {
      console.warn(
        "[Pi Shell] Failed to register global shortcut Ctrl+Shift+P (may be taken by another app)"
      );
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
}
