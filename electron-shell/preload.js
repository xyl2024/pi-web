// preload.js — bridge between renderer and main process
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piShell", {
  version: "1.0.0",
  retry: () => ipcRenderer.send("retry-connection"),
});
