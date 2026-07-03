const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  run: (platform, action, options) => ipcRenderer.invoke("installer:run", { platform, action, options }),
  getConfig: () => ipcRenderer.invoke("installer:getConfig"),
  onLog: (callback) => ipcRenderer.on("installer:log", (event, payload) => callback(payload)),
  copyText: (text) => ipcRenderer.invoke("installer:copyText", text),
  selectFile: () => ipcRenderer.invoke("installer:selectFile")
});
