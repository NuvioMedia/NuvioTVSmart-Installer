// Same window.installer API as the desktop preload.js, routed to the native iOS host.
(function () {
  const call = (method, ...args) => window.webkit.messageHandlers.installer.postMessage({ method, args });
  let logCallback = null;
  window.__nuvioEmitLog = (payload) => { if (logCallback) logCallback(payload); };
  window.installer = {
    run: (platform, action, options) => call("run", { platform, action, options }),
    getConfig: () => call("getConfig"),
    getRecentReleases: (platform) => call("getRecentReleases", platform),
    getLgDevices: () => call("getLgDevices"),
    deleteLgDevice: (deviceName) => call("deleteLgDevice", deviceName),
    onLog: (callback) => { logCallback = callback; },
    startSamsungLogs: (ip) => call("startSamsungLogs", ip),
    saveText: (text, defaultName) => call("saveText", text, defaultName),
    copyText: (text) => call("copyText", text),
    selectFile: () => call("selectFile")
  };
})();
