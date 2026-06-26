// preload.js — bridge between renderer and main process.
// Exposes a small, controlled surface to the title bar (titlebar.html).
// The Pi Web app runs inside an <iframe> at http://localhost:<port>, so it
// does not receive this preload — its UI talks to the Next.js server
// directly via HTTP and SSE.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piShell", {
  version: "1.0.0",
  piUrl: `http://localhost:${process.env.PI_PORT || "14514"}`,
  minimize: () => ipcRenderer.send("titlebar-minimize"),
  maximize: () => ipcRenderer.send("titlebar-maximize"),
  close: () => ipcRenderer.send("titlebar-close"),
  retry: () => ipcRenderer.send("retry-connection"),
  onIframeError: (handler) =>
    ipcRenderer.on("iframe-error", (_e, errorPageUrl) => handler(errorPageUrl)),
  onIframeRetry: (handler) => ipcRenderer.on("iframe-retry", () => handler()),
});
