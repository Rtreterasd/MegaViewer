const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mega", {
  playback: (value, id) => ipcRenderer.invoke("playback", value, id),
  retryMedia: (id) => ipcRenderer.invoke("retry-media", id),
  fileMenu: (id, key) => ipcRenderer.invoke("file-menu", id, key),
  downloadFile: (id, key) => ipcRenderer.invoke("download-file", id, key),
  downloads: () => ipcRenderer.invoke("downloads-list"),
  downloadAction: (action, id) =>
    ipcRenderer.invoke("download-action", action, id),
  onDownloads: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("downloads-changed", listener);
    return () => ipcRenderer.removeListener("downloads-changed", listener);
  },
  onShowDownloads: (callback) =>
    ipcRenderer.on("show-downloads", () => callback()),
  window: (action) => ipcRenderer.invoke("window", action),
  mediaError: (id) => ipcRenderer.invoke("media-error", id),
  open: (url, atRoot = false) => ipcRenderer.invoke("open", url, atRoot),
  history: () => ipcRenderer.invoke("history"),
  clearHistory: () => ipcRenderer.invoke("clear-history"),
  clearCache: () => ipcRenderer.invoke("clear-cache"),
  putThumb: (id, data, key) => ipcRenderer.invoke("put-thumb", id, data, key),
});
