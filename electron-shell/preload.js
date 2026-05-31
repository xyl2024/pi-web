// preload.js — minimal bridge for Phase 2 (native notifications, text selection, etc.)
// For Phase 1, this is intentionally empty; contextIsolation is enabled.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('piShell', {
  version: '1.0.0',
});
