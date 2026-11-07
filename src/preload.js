const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  run: (platform, action, options) => ipcRenderer.invoke("installer:run", { platform, action, options }),
  getConfig: () => ipcRenderer.invoke("installer:getConfig"),
  getRecentReleases: (platform) => ipcRenderer.invoke("installer:getRecentReleases", platform),
  getLgDevices: () => ipcRenderer.invoke("installer:getLgDevices"),
  deleteLgDevice: (deviceName) => ipcRenderer.invoke("installer:deleteLgDevice", deviceName),
  onLog: (callback) => ipcRenderer.on("installer:log", (event, payload) => callback(payload)),
  startSamsungLogs: (ip) => ipcRenderer.invoke("installer:startSamsungLogs", ip),
  saveText: (text, defaultName) => ipcRenderer.invoke("installer:saveText", text, defaultName),
  copyText: (text) => ipcRenderer.invoke("installer:copyText", text),
  selectFile: () => ipcRenderer.invoke("installer:selectFile")
});
