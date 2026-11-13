// Minimal stand-in for the Electron API used by main.js when the installer runs as a plain Node CLI
// (node, or the packaged binary with ELECTRON_RUN_AS_NODE=1). Paths match the desktop app so the
// CLI shares downloaded packages and Samsung certificates with it.
const os = require("node:os");
const path = require("node:path");

const appName = "Nuvio TV Installer";

function appDataPath() {
  if (process.platform === "win32") return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

const app = {
  setName() {},
  setAppUserModelId() {},
  whenReady: () => new Promise(() => {}),
  on() {},
  quit() {},
  getPath(name) {
    if (name === "userData") return process.env.NUVIO_INSTALLER_DATA_DIR || path.join(appDataPath(), appName);
    if (name === "appData") return appDataPath();
    if (name === "temp") return os.tmpdir();
    if (name === "downloads") return path.join(os.homedir(), "Downloads");
    return os.homedir();
  }
};

const shell = {
  openExternal(url) {
    process.stderr.write(`\nOpen this URL in a browser on this computer to continue:\n${url}\n\n`);
    return Promise.resolve();
  }
};

module.exports = {
  app,
  shell,
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  clipboard: { writeText() {} },
  dialog: {},
  ipcMain: { handle() {} }
};
