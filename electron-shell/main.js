// main.js — Pi Agent Electron Shell
// Phase 1: window + tray + global shortcut + single-instance + auto-retry

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
} = require("electron");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────
const PI_PORT = process.env.PI_PORT || "14514";
const PI_URL = `http://localhost:${PI_PORT}`;
const MAX_RETRIES = 30;       // 30 attempts
const RETRY_INTERVAL = 2000;  // 2 seconds between retries

// ── CLI flags ────────────────────────────────────────────────────────
const startHidden = process.argv.includes("--hidden");

// ── State ───────────────────────────────────────────────────────────
let win = null;
let tray = null;
let isQuitting = false;
let retryTimer = null;

// ── App icon (generated programmatically — no asset file needed) ────
// Draws a blue "P" letter on transparent background at any resolution.
// Original glyph designed on a 16-unit grid; scaled up for larger sizes.
function createAppIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 16; // scale factor from the 16x16 design grid

  // "P" glyph bounding box on the 16-unit grid
  const LX = 2, RX = 4;       // left vertical bar x-range
  const TX = 2, TX2 = 11;     // top horizontal bar
  const MX = 2, MX2 = 11;     // middle horizontal bar
  const RV = 11;              // right vertical bar x
  const TY = 1, MY = 7;       // top bar y, middle bar y
  const RY1 = 1, RY2 = 7;     // right bar y-range

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const gx = x / s; // grid-x
      const gy = y / s; // grid-y

      const inP =
        (gx >= LX && gx < RX + 1) ||                              // left bar
        (gy >= TY && gy < TY + 1 && gx >= TX && gx < TX2 + 1) || // top bar
        (gy >= MY && gy < MY + 1 && gx >= MX && gx < MX2 + 1) || // middle bar
        (gy >= RY1 && gy < RY2 + 1 && gx >= RV && gx < RV + 1);  // right bar

      if (inP) {
        buf[i] = 0x4a;     // R
        buf[i + 1] = 0x90; // G
        buf[i + 2] = 0xd9; // B
        buf[i + 3] = 255;  // A
      } else {
        buf[i] = 0;
        buf[i + 1] = 0;
        buf[i + 2] = 0;
        buf[i + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// ── HTML pages for waiting / timeout ────────────────────────────────
function waitingHtml(attempt) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
display:flex;justify-content:center;align-items:center;height:100vh;
background:#0f0f1a;color:#c8c8d0}
.container{text-align:center;max-width:400px}
h1{font-size:22px;font-weight:500;margin-bottom:12px;color:#e0e0e8}
p{font-size:14px;color:#787888}
.dots{display:inline-block;width:24px;text-align:left}
.spinner{margin:20px auto;width:32px;height:32px;border:3px solid #2a2a3a;
border-top-color:#4a90d9;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="container">
<div class="spinner"></div>
<h1>等待 Pi 服务启动<span class="dots" id="dots"></span></h1>
<p id="status">正在连接 localhost:${PI_PORT}（第 ${attempt}/${MAX_RETRIES} 次）</p>
</div>
<script>
let n=0;setInterval(()=>{n=(n+1)%4;document.getElementById('dots').textContent='.'.repeat(n)},500)
</script></body></html>`)}`;
}

function timeoutHtml() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
display:flex;justify-content:center;align-items:center;height:100vh;
background:#0f0f1a;color:#c8c8d0}
.container{text-align:center;max-width:400px}
h1{font-size:22px;font-weight:500;margin-bottom:12px;color:#e74c3c}
p{font-size:14px;color:#787888;margin-bottom:6px}
button{margin-top:16px;padding:10px 24px;font-size:15px;border:none;
border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer}
button:hover{background:#3a7bc8}
</style></head><body><div class="container">
<h1>无法连接到 Pi 服务</h1>
<p>请确保 WSL2 中 Pi Agent Web 已启动</p>
<p>端口：localhost:${PI_PORT}</p>
<button onclick="location.reload()">手动重试</button>
</div></body></html>`)}`;
}

// ── Load Pi with retry logic ────────────────────────────────────────
async function loadPiWithRetry() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[Pi Shell] Connecting to ${PI_URL} (${attempt}/${MAX_RETRIES})`
      );
      await win.loadURL(PI_URL);
      console.log("[Pi Shell] Connected!");
      return; // success
    } catch (_err) {
      // Show waiting page, update on each retry
      if (attempt < MAX_RETRIES) {
        await win.loadURL(waitingHtml(attempt));
        await new Promise((resolve) => {
          retryTimer = setTimeout(resolve, RETRY_INTERVAL);
        });
      }
    }
  }

  // All retries exhausted
  await win.loadURL(timeoutHtml());
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
    icon: createAppIcon(64),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadPiWithRetry();

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
  tray = new Tray(createAppIcon(16));
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

  // Double-click tray icon to show window
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
    // Focus existing window when a second instance is launched
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();

    // Global shortcut: Ctrl+Shift+P to toggle window
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
    if (retryTimer) clearTimeout(retryTimer);
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
}
