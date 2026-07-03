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
<button id="retry-btn">手动重试</button>
<script>
document.getElementById("retry-btn").addEventListener("click", function () {
  try { parent.postMessage("pi-retry", "*"); } catch (_) {}
});
</script>
</div></body></html>`)}`;
}

// ── BrowserWindow ───────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: "Pi Work",
    autoHideMenuBar: true,
    show: !startHidden,
    icon: iconPath,
    // Hide the native title bar — the macOS-style traffic lights are
    // drawn in titlebar.html and the Pi Web app runs inside an <iframe>.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Iframe (subframe) load failure → ask the title bar to swap the
  // iframe's src to the error page. The main frame (titlebar.html) is a
  // local file and should always load, so we ignore main-frame failures.
  win.webContents.on("did-fail-load", (_event, _code, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame && validatedURL && validatedURL.startsWith(PI_URL)) {
      win.webContents.send("iframe-error", errorPage());
    }
  });

  // IPC: title bar traffic-light buttons
  ipcMain.on("titlebar-close", () => {
    if (win) win.close(); // 'close' handler below hides to tray
  });

  ipcMain.on("titlebar-minimize", () => {
    if (win) win.minimize();
  });

  ipcMain.on("titlebar-maximize", () => {
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  // IPC: manual retry from the error page (the error page lives inside
  // the iframe and reaches us via window.top.location.reload(); the
  // title bar's iframe-retry listener then restores the Pi URL).
  ipcMain.on("retry-connection", () => {
    if (win) {
      console.log("[Pi Shell] Manual retry...");
      win.webContents.send("iframe-retry");
    }
  });

  // DevTools: F12 or Ctrl+Shift+I toggles it (no native menu means the
  // default accelerators are not registered, so wire them up manually).
  win.webContents.on("before-input-event", (_event, input) => {
    if (
      input.type === "keyDown" &&
      (input.key === "F12" ||
        (input.control && input.shift && input.key.toLowerCase() === "i"))
    ) {
      win.webContents.toggleDevTools();
    }
  });

  // Load the title bar — the Pi Web app is loaded inside its <iframe>.
  console.log(`[Pi Shell] Loading title bar (iframe will connect to ${PI_URL})`);
  win.loadFile(path.join(__dirname, "titlebar.html"));

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
  tray.setToolTip("Pi Work");

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
