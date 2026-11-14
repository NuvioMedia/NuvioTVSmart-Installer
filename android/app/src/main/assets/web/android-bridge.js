// Same window.installer API as the desktop preload.js, routed to the native Android host (NuvioAndroid).
(function () {
  let seq = 0;
  const pending = new Map();
  let logCallback = null;

  window.__nuvioResolve = (id, ok, json) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const value = json == null ? null : JSON.parse(json);
    if (ok) entry.resolve(value); else entry.reject(new Error(value));
  };

  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    NuvioAndroid.postMessage(JSON.stringify({ id, method, args }));
  });

  window.__nuvioEmitLog = (payload) => { if (logCallback) logCallback(payload); };

  // Native → shared desktop code (nuvio-core.js): runs `body` as an async function of `args`.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  window.__nuvioCoreCall = async (id, body, args) => {
    try {
      const names = Object.keys(args || {});
      const result = await new AsyncFunction(...names, body)(...names.map((name) => args[name]));
      NuvioAndroid.coreResult(id, true, JSON.stringify(result === undefined ? null : result));
    } catch (error) {
      NuvioAndroid.coreResult(id, false, JSON.stringify(String((error && error.message) || error)));
    }
  };

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
