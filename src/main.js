
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const querystring = require("node:querystring");
const { Readable } = require("node:stream");
const adbhost = require("adbhost");
const AdbPacket = require("adbhost/lib/packet.js");
const JSZip = require("jszip");
const forge = require("node-forge");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const { Signature, SamsungCertificateCreator } = require("tizen");

const configPath = path.join(__dirname, "..", "installer.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const appDisplayName = "Nuvio TV Installer";
const legacyUserDataNames = ["Nuvio WebTV Installer"];
const isWindows = process.platform === "win32";
const appIconPath = path.join(__dirname, "..", "build", "icon.png");
const adbCommands = AdbPacket.commands;
const tizenEngineFsServicePath = "services/tizen/enginefs-service.js";
const tizenEngineFsRuntimePaths = [
  "services/tizen/runtime/media-http.cjs",
  "services/tizen/runtime/tx3g-subtitle-parser.cjs",
  "services/tizen/runtime/tx3g-subtitle-service.cjs",
  "services/tizen/runtime/embedded-text-subtitle-parser.cjs"
];
const tizenEngineFsServicePort = 2710;
const tizenPluginServicePath = "services/tizen/plugin-service.js";
const tizenPluginServiceSourcePath = "services/plugin-http.cjs";
const tizenPluginServicePort = 2711;
let migratedLegacySamsungCertificateCount = 0;

app.setName(appDisplayName);
if (isWindows) {
  app.setAppUserModelId("space.nuvio.webtvinstaller");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    title: appDisplayName,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  await migrateLegacySamsungCertificateStore();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function emit(event, payload) {
  event.sender.send("installer:log", payload);
}

function getLocalIPv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function executableCandidates(command) {
  const names = isWindows ? [`${command}.exe`, `${command}.bat`, `${command}.cmd`, command] : [command];
  const home = os.homedir();
  const localBinDir = path.join(__dirname, "..", "node_modules", ".bin");
  const roots = isWindows
    ? [
        "C:\\tizen-studio",
        path.join(process.env.LOCALAPPDATA || "", "tizen-studio")
      ]
    : [
        path.join(home, "tizen-studio"),
        "/opt/tizen-studio"
      ];

  const tizenSubdir = command === "tizen" ? path.join("tools", "ide", "bin") : "tools";
  return [
    ...names.map((name) => path.join(localBinDir, name)),
    ...webOsCliCandidates(command),
    ...roots.flatMap((root) => names.map((name) => path.join(root, tizenSubdir, name)))
  ];
}

function webOsCliCandidates(command) {
  if (!command.startsWith("ares")) {
    return [];
  }

  try {
    const packageJsonPath = require.resolve("@webos-tools/cli/package.json");
    const packageRoot = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const binPath = packageJson.bin?.[command];
    return binPath ? [path.join(packageRoot, binPath)] : [];
  } catch {
    return [];
  }
}

function lookupCommand(command) {
  return new Promise((resolve) => {
    const lookup = isWindows ? "where" : "which";
    const child = spawn(lookup, [command], { shell: false });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("exit", (code) => {
      const firstMatch = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(code === 0 && firstMatch ? firstMatch : "");
    });
    child.on("error", () => resolve(""));
  });
}

async function resolveCommand(command) {
  if (command.startsWith("ares")) {
    const packagedCommand = await resolveCandidateCommand(command);
    if (packagedCommand) {
      return packagedCommand;
    }
  }

  const fromPath = await lookupCommand(command);
  if (fromPath) {
    return fromPath;
  }

  return resolveCandidateCommand(command);
}

async function resolveCandidateCommand(command) {
  for (const candidate of executableCandidates(command)) {
    try {
      await fsp.access(candidate, candidate.endsWith(".js") ? fs.constants.R_OK : fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  return "";
}

function runCommand(event, command, args, options = {}) {
  const spawnSpec = resolveSpawnSpec(command, args);
  emit(event, { type: "command", text: `$ ${spawnSpec.displayCommand} ${formatCommandArgs(spawnSpec.args)}` });

  return new Promise((resolve, reject) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      shell: spawnSpec.shell,
      cwd: options.cwd || undefined,
      env: spawnSpec.env
    });

    let stderr = "";
    child.stdout.on("data", (chunk) => emit(event, { type: "stdout", text: chunk.toString() }));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      emit(event, { type: "stderr", text });
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`${command} exited with code ${code}`);
        error.code = code;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function captureCommand(event, command, args, options = {}) {
  const spawnSpec = resolveSpawnSpec(command, args);
  emit(event, { type: "command", text: `$ ${spawnSpec.displayCommand} ${formatCommandArgs(spawnSpec.args)}` });

  return new Promise((resolve, reject) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      shell: spawnSpec.shell,
      cwd: options.cwd || undefined,
      env: spawnSpec.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function finish(error, result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    }

    const timeout = options.timeoutMs ? setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs) : null;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      emit(event, { type: "stdout", text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      emit(event, { type: "stderr", text });
    });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
      } else {
        const error = new Error(`${command} exited with code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(error);
      }
    });
  });
}

function resolveSpawnSpec(command, args) {
  if (String(command).endsWith(".js")) {
    const sshCompatPatch = path.join(__dirname, "webos-ssh-compat-patch.js");
    return {
      command: process.execPath,
      args: ["--require", sshCompatPatch, command, ...args],
      displayCommand: command,
      shell: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1"
      }
    };
  }

  return {
    command,
    args,
    displayCommand: command,
    shell: isWindows && /\.(?:bat|cmd)$/i.test(String(command)),
    env: process.env
  };
}

function formatCommandArgs(args) {
  const hiddenValueFlags = new Set(["--passphrase"]);
  return args
    .map((arg, index) => hiddenValueFlags.has(args[index - 1]) ? "********" : arg)
    .join(" ");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "Nuvio-TV-Installer"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function downloadFile(event, url, targetPath) {
  emit(event, { type: "info", text: `Download ${url}` });
  const response = await fetch(url, {
    headers: { "User-Agent": "Nuvio-TV-Installer" }
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const file = fs.createWriteStream(targetPath);
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(response.body);
    body.pipe(file);
    body.on("error", reject);
    file.on("finish", resolve);
    file.on("error", reject);
  });
}

function releaseAssetForPlatform(release, platform) {
  const platformConfig = config[platform];
  const matcher = new RegExp(platformConfig.assetPattern, "i");
  return Array.isArray(release?.assets)
    ? release.assets.find((item) => matcher.test(item.name))
    : null;
}

function normalizeReleasePlatform(platform) {
  const normalized = String(platform || "").trim().toLowerCase();
  if (normalized === "lg") return "webos";
  if (normalized === "samsung") return "tizen";
  return normalized;
}

async function getRecentReleases(platform, limit = 3) {
  const releasePlatform = normalizeReleasePlatform(platform);
  if (!config[releasePlatform]) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const releases = await fetchJson(`https://api.github.com/repos/${config.githubRepo}/releases?per_page=20`);
  return releases
    .filter((release) => !release.draft && releaseAssetForPlatform(release, releasePlatform))
    .slice(0, limit)
    .map((release) => ({
      id: release.id,
      tagName: release.tag_name,
      name: release.name || release.tag_name,
      publishedAt: release.published_at,
      prerelease: Boolean(release.prerelease)
    }));
}

async function resolveReleaseAsset(event, platform, releaseId) {
  const normalizedReleaseId = String(releaseId || "").trim();
  if (normalizedReleaseId && !/^\d+$/.test(normalizedReleaseId)) {
    throw new Error("Invalid GitHub release selection.");
  }

  const releaseUrl = normalizedReleaseId
    ? `https://api.github.com/repos/${config.githubRepo}/releases/${normalizedReleaseId}`
    : `https://api.github.com/repos/${config.githubRepo}/releases/latest`;
  const release = await fetchJson(releaseUrl);
  const asset = releaseAssetForPlatform(release, platform);

  if (!asset) {
    throw new Error(`No ${platform} package was found in GitHub release ${release.tag_name || normalizedReleaseId || "latest"}.`);
  }

  const cacheKey = String(release.tag_name || normalizedReleaseId || "latest").replace(/[^a-z0-9._-]+/gi, "-");
  const cacheDir = path.join(app.getPath("userData"), "packages", cacheKey);
  const targetPath = path.join(cacheDir, asset.name);

  try {
    await fsp.access(targetPath, fs.constants.R_OK);
    emit(event, { type: "info", text: `Using already downloaded package: ${targetPath}` });
  } catch {
    await downloadFile(event, asset.browser_download_url, targetPath);
  }

  return targetPath;
}

function requireValue(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

async function runLg(event, action, options) {
  const ip = String(options.ip || "").trim();
  const passphrase = String(options.lgPassphrase || "").trim();
  let device;
  if (passphrase) {
    device = await configureLgDevice(event, ip, options.deviceName, passphrase);
  } else {
    device = await resolveExistingLgDevice(event, options.deviceName, ip);
  }
  const aresInstall = await resolveCommand("ares-install");
  if (!aresInstall) {
    throw new Error("ares-install was not found in the app package.");
  }

  if (action === "launch") {
    const aresLaunch = await resolveCommand("ares-launch");
    if (!aresLaunch) {
      throw new Error("ares-launch was not found in the app package.");
    }
    await runCommand(event, aresLaunch, ["--device", device, config.webos.appId]);
    return;
  }

  if (action === "uninstall") {
    await runCommand(event, aresInstall, ["--device", device, "--remove", config.webos.appId]);
    return;
  }

  const packagePath = options.packagePath || await resolveReleaseAsset(event, "webos", options.releaseId);
  try {
    await runCommand(event, aresInstall, ["--device", device, packagePath]);
  } catch (error) {
    const errorDetails = `${error?.message || ""}\n${error?.stderr || ""}`;
    if (!passphrase && /authentication methods failed|ssh exec failure/i.test(errorDetails)) {
      throw new Error(
        `LG authentication failed for device "${device}". Enter the current Developer Mode passphrase and press Install again to overwrite the saved profile and SSH key.`
      );
    }
    throw error;
  }
}

function defaultLgDeviceName(ip) {
  return `nuvio-lg-${String(ip || "").trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "tv"}`;
}

function lgDeviceInfoArgs(host) {
  return [
    "--info", "username=prisoner",
    "--info", `host=${host}`,
    "--info", "port=9922",
    "--info", "default=true"
  ];
}

function getWebOsCliDataDirectory() {
  // @webos-tools/cli resolves its data directory from APPDATA first on
  // Windows, then HOME/USERPROFILE. Mirror that resolution so the installer
  // reads and updates the same novacom-devices.json as ares-setup-device.
  const cliHome = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.resolve(cliHome, ".webos", "tv");
}

function getWebOsCliSshDirectory() {
  // ares-novacom resolves SSH keys from HOME/USERPROFILE, independently of
  // the CLI data directory. Keep key discovery aligned with that behavior.
  const cliHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.resolve(cliHome, ".ssh");
}

async function readLgDevices() {
  const devicesPath = path.join(getWebOsCliDataDirectory(), "novacom-devices.json");

  try {
    const devices = JSON.parse(await fsp.readFile(devicesPath, "utf8"));
    return Array.isArray(devices) ? devices : [];
  } catch {
    return [];
  }
}

async function listRegisteredLgDevices() {
  const devices = await readLgDevices();
  const registered = await Promise.all(devices.map(async (entry) => {
    const name = String(entry?.name || "").trim();
    const host = String(entry?.host || "").trim();
    const privateKey = String(entry?.privateKey?.openSsh || "").trim();
    if (!name) {
      return null;
    }

    let keyReady = false;
    if (privateKey) {
      try {
        await fsp.access(path.join(getWebOsCliSshDirectory(), privateKey), fs.constants.R_OK);
        keyReady = true;
      } catch {}
    }

    return {
      name,
      host,
      default: isDefaultLgDevice(entry),
      keyReady,
      removable: entry?.indelible !== true
    };
  }));

  const uniqueDevices = new Map();
  registered.filter(Boolean).forEach((device) => {
    const key = device.name.toLowerCase();
    const existing = uniqueDevices.get(key);
    const deviceScore = Number(device.keyReady) * 2 + Number(device.default);
    const existingScore = existing ? Number(existing.keyReady) * 2 + Number(existing.default) : -1;
    if (deviceScore > existingScore) {
      uniqueDevices.set(key, device);
    }
  });

  return Array.from(uniqueDevices.values())
    .sort((left, right) => Number(right.default) - Number(left.default) || left.name.localeCompare(right.name));
}

function isDefaultLgDevice(entry) {
  return entry?.default === true || String(entry?.default || "").toLowerCase() === "true";
}

async function findExistingLgDeviceWithPrivateKey(deviceName, host, options = {}) {
  const devices = await readLgDevices();
  const normalizedDeviceName = String(deviceName || "").trim();
  const normalizedHost = String(host || "").trim();
  const devicesWithKeys = devices.filter((entry) => entry?.privateKey?.openSsh);
  const hostMatches = normalizedHost
    ? devicesWithKeys.filter((entry) => String(entry.host || "") === normalizedHost)
    : devicesWithKeys;

  let device = normalizedDeviceName
    ? hostMatches.find((entry) => entry.name === normalizedDeviceName)
    : null;

  if (!device && options.allowDifferentHostForName && normalizedDeviceName) {
    device = devicesWithKeys.find((entry) => entry.name === normalizedDeviceName);
  }

  if (!device && !normalizedDeviceName && !normalizedHost) {
    device = hostMatches.find(isDefaultLgDevice);
  }

  if (!device) {
    device = hostMatches[0];
  }

  if (!device) {
    return null;
  }

  const keyPath = path.join(getWebOsCliSshDirectory(), device.privateKey.openSsh);
  try {
    await fsp.access(keyPath, fs.constants.R_OK);
    return {
      deviceName: device.name,
      host: String(device.host || ""),
      keyPath
    };
  } catch {
    return null;
  }
}

async function resolveExistingLgDevice(event, requestedDeviceName, ip) {
  const deviceName = String(requestedDeviceName || "").trim();
  const host = String(ip || "").trim();
  const existingDevice = await findExistingLgDeviceWithPrivateKey(deviceName, host, {
    allowDifferentHostForName: Boolean(deviceName && host)
  });

  if (!existingDevice) {
    throw new Error(
      "No usable SSH key was found for this LG device. Enter the TV IP and current Developer Mode passphrase, then press Install to create or overwrite the saved profile."
    );
  }

  if (!deviceName && !host) {
    const deviceLabel = existingDevice.host
      ? `${existingDevice.deviceName} (${existingDevice.host})`
      : existingDevice.deviceName;
    emit(event, { type: "info", text: `Using saved LG webOS device profile: ${deviceLabel}.` });
  }

  if (deviceName && host && existingDevice.deviceName === deviceName && existingDevice.host !== host) {
    const aresSetupDevice = await resolveCommand("ares-setup-device");
    if (!aresSetupDevice) {
      throw new Error("ares-setup-device was not found in the app package.");
    }

    emit(event, { type: "info", text: `Updating LG device profile "${deviceName}" from ${existingDevice.host || "unknown host"} to ${host}.` });
    await runCommand(event, aresSetupDevice, ["--modify", deviceName, ...lgDeviceInfoArgs(host)]);
    emit(event, { type: "success", text: "LG device IP updated." });
  }

  return existingDevice.deviceName;
}

async function configureLgDevice(event, ip, requestedDeviceName, passphrase) {
  const host = requireValue(ip, "IP LG TV");
  const deviceName = String(requestedDeviceName || "").trim() || defaultLgDeviceName(host);
  const aresSetupDevice = await resolveCommand("ares-setup-device");
  const aresNovacom = await resolveCommand("ares-novacom");

  if (!aresSetupDevice || !aresNovacom) {
    throw new Error("webOS commands ares-setup-device/ares-novacom were not found in the app package.");
  }

  emit(event, { type: "info", text: `Automatically configuring LG webOS device: ${deviceName}` });
  const deviceInfoArgs = lgDeviceInfoArgs(host);
  const matchingDevices = (await readLgDevices()).filter((entry) => entry?.name === deviceName);
  const canReplace = matchingDevices.length > 0 && matchingDevices.every((entry) => entry?.indelible !== true);

  if (canReplace) {
    emit(event, { type: "info", text: `Replacing existing LG device profile "${deviceName}" and its saved authentication.` });
    await runCommand(event, aresSetupDevice, ["--remove", deviceName]);
    await runCommand(event, aresSetupDevice, ["--add", deviceName, ...deviceInfoArgs]);
  } else if (matchingDevices.length > 0) {
    emit(event, { type: "info", text: `Updating protected LG device profile "${deviceName}".` });
    await runCommand(event, aresSetupDevice, ["--modify", deviceName, ...deviceInfoArgs]);
  } else {
    await runCommand(event, aresSetupDevice, ["--add", deviceName, ...deviceInfoArgs]);
  }

  emit(event, { type: "info", text: `Downloading and overwriting the SSH key for "${deviceName}".` });
  await runCommand(event, aresNovacom, ["--device", deviceName, "--getkey", "--passphrase", passphrase]);
  emit(event, { type: "success", text: "LG profile and SSH key saved." });
  return deviceName;
}

async function deleteLgDevice(event, requestedDeviceName) {
  const deviceName = requireValue(requestedDeviceName, "LG device name");
  const matchingDevices = (await readLgDevices()).filter((entry) => entry?.name === deviceName);
  if (!matchingDevices.length) {
    throw new Error(`LG device profile "${deviceName}" was not found.`);
  }
  if (matchingDevices.some((entry) => entry?.indelible === true)) {
    throw new Error(`LG device profile "${deviceName}" is protected by the webOS CLI and cannot be deleted.`);
  }

  const aresSetupDevice = await resolveCommand("ares-setup-device");
  if (!aresSetupDevice) {
    throw new Error("ares-setup-device was not found in the app package.");
  }

  await runCommand(event, aresSetupDevice, ["--remove", deviceName]);
  emit(event, { type: "success", text: `LG device profile "${deviceName}" deleted.` });
}

function parseSdbTarget(output, ip) {
  const normalizedIp = String(ip || "").trim();
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .find((target) => target && target !== "List" && target.includes(normalizedIp)) || "";
}

async function connectSamsungDevice(event, sdb, ip) {
  await runCommand(event, sdb, ["connect", ip]);
  const devices = await captureCommand(event, sdb, ["devices"]);
  const target = parseSdbTarget(devices.stdout, ip);
  if (!target) {
    throw new Error(`Samsung TV was not found in "sdb devices" after connecting to ${ip}. Check Developer Mode and Host PC IP on the TV.`);
  }
  emit(event, { type: "info", text: `Detected SDB target: ${target}` });
  return target;
}

function connectSamsungAdb(event, ip) {
  emit(event, { type: "info", text: `Direct connection to Samsung TV ${ip}:26101.` });

  return new Promise((resolve, reject) => {
    const adbClient = adbhost.createConnection({ host: ip, port: 26101 });
    let settled = false;

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        try {
          adbClient._stream?.destroy();
        } catch {}
        reject(error);
        return;
      }
      emit(event, { type: "success", text: "Direct Samsung connection is active." });
      resolve(adbClient);
    }

    const timeout = setTimeout(() => {
      finish(new Error("Timed out while opening direct Samsung connection."));
    }, 6000);

    adbClient._stream.on("connect", () => {
      setTimeout(() => finish(), 800);
    });
    adbClient._stream.on("error", (error) => {
      if (error?.code === "ECONNREFUSED") {
        finish(new Error("Samsung TV refused the direct connection. Check that Developer Mode is enabled and the TV IP is correct."));
        return;
      }
      if (error?.code === "ECONNRESET") {
        finish(new Error("Samsung TV reset the direct connection. Check that Host PC IP matches this Mac and restart the TV by holding Power until the Samsung logo appears."));
        return;
      }
      finish(error);
    });
    adbClient._stream.on("close", () => {
      if (!settled) {
        finish(new Error("Direct Samsung connection was closed."));
      }
    });
  });
}

async function connectSamsungTransport(event, ip) {
  let adbClient = null;
  try {
    adbClient = await connectSamsungAdb(event, ip);
    await captureSamsungShell(event, { type: "adb", adbClient, target: ip }, ["0", "getduid"], { timeoutMs: 8000, logOutput: false });
    return { type: "adb", adbClient, target: ip };
  } catch (error) {
    try {
      adbClient?._stream?.destroy();
    } catch {}
    emit(event, { type: "info", text: `Direct connection failed (${error.message}). Trying sdb fallback.` });
  }

  const sdb = await resolveCommand("sdb");
  if (!sdb) {
    throw new Error("Unable to connect to the TV. Check Developer Mode, Host PC IP, and that the PC/TV are on the same network. sdb fallback is not available.");
  }

  const target = await connectSamsungDevice(event, sdb, ip);
  return { type: "sdb", sdb, target };
}

async function connectSamsungSdbTransport(event, ip) {
  const sdb = await resolveCommand("sdb");
  if (!sdb) {
    throw new Error("Samsung sdb fallback is not available on this computer because sdb was not found. Direct Samsung install failed before fallback. Check the vd_appinstall error shown above, or install Samsung/Tizen sdb if you want fallback install/uninstall.");
  }

  const target = await connectSamsungDevice(event, sdb, ip);
  return { type: "sdb", sdb, target };
}

function closeSamsungTransport(transport) {
  if (transport?.type !== "adb") {
    return;
  }

  try {
    transport.adbClient?._stream?.end();
    transport.adbClient?._stream?.destroy();
  } catch {}
}

function adbCreateStream(adbClient, command, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const idleAfterDataMs = options.idleAfterDataMs || 500;
  const noOutputSuccessMs = options.noOutputSuccessMs || 0;
  const completeWhen = options.completeWhen || null;

  return new Promise((resolve, reject) => {
    const stream = adbClient.createStream(command);
    let output = "";
    let settled = false;
    let idleTimer = null;
    let noOutputTimer = null;

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(idleTimer);
      clearTimeout(noOutputTimer);
      try {
        stream.destroy();
      } catch {}
      if (error) {
        reject(error);
        return;
      }
      resolve(output);
    }

    const timeout = setTimeout(() => {
      try {
        stream.destroy();
      } catch {}
      finish(new Error(`Timed out waiting for Samsung shell command: ${command}`));
    }, timeoutMs);

    if (noOutputSuccessMs > 0) {
      noOutputTimer = setTimeout(() => finish(), noOutputSuccessMs);
    }

    stream.on("data", (chunk) => {
      output += chunk.toString();
      clearTimeout(noOutputTimer);
      clearTimeout(idleTimer);
      if (completeWhen && completeWhen.test(output)) {
        finish();
        return;
      }
      if (!completeWhen && idleAfterDataMs > 0) {
        idleTimer = setTimeout(() => finish(), idleAfterDataMs);
      }
    });
    stream.on("error", finish);
    stream.on("end", () => finish());
    stream.on("close", () => finish());
  });
}

async function captureSamsungShell(event, transport, args, options = {}) {
  if (transport.type === "adb") {
    const command = `shell:${args.join(" ")}`;
    emit(event, { type: "command", text: `$ adbhost ${command}` });
    const stdout = await adbCreateStream(transport.adbClient, command, options);
    if (stdout && options.logOutput !== false) {
      emit(event, { type: "stdout", text: stdout });
    }
    return { stdout, stderr: "" };
  }

  return captureCommand(event, transport.sdb, ["-s", transport.target, "shell", ...args], options);
}

async function runSamsungShell(event, transport, args, options = {}) {
  const result = await captureSamsungShell(event, transport, args, options);
  return result.stdout;
}

function isSamsungShellClosedOutput(output) {
  return String(output || "")
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === "closed");
}

function isSamsungShellClosedError(error) {
  return isSamsungShellClosedOutput(error?.stdout)
    || isSamsungShellClosedOutput(error?.stderr)
    || /\bclosed\b/i.test(String(error?.message || ""));
}

async function ensureSamsungTempDirectory(event, transport) {
  try {
    const output = await runSamsungShell(event, transport, ["0", "mkdir", "-p", "/home/owner/share/tmp/sdk_tools"], {
      noOutputSuccessMs: 1500
    });
    if (isSamsungShellClosedOutput(output)) {
      emit(event, {
        type: "info",
        text: "Samsung TV closed the generic shell setup command; continuing with direct push and vd_appinstall."
      });
      return false;
    }
    return true;
  } catch (error) {
    if (isSamsungShellClosedError(error)) {
      emit(event, {
        type: "info",
        text: "Samsung TV closed the generic shell setup command; continuing with direct push and vd_appinstall."
      });
      return false;
    }
    throw error;
  }
}

function pushFileAdb(adbClient, remotePath, data) {
  return new Promise((resolve, reject) => {
    const shell = adbClient.createStream("sync:");
    let interval;
    let settled = false;

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(interval);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }

    const timeout = setTimeout(() => {
      finish(new Error(`Timeout push ${remotePath}`));
    }, 30000);

    shell.on("error", (error) => {
      finish(error);
    });

    interval = setInterval(() => {
      if (shell._remoteId === -1) {
        return;
      }

      try {
        const statBuffer = Buffer.alloc(8);
        statBuffer.write("STAT", 0);
        statBuffer.writeUInt32LE(remotePath.length, 4);
        adbClient._writePacket(adbCommands.WRTE, shell._localId, shell._remoteId, statBuffer);
        adbClient._writePacket(adbCommands.WRTE, shell._localId, shell._remoteId, Buffer.from(remotePath));

        const sendBuffer = Buffer.alloc(8);
        sendBuffer.writeUInt32LE(0x444E4553, 0);
        sendBuffer.writeUInt32LE(remotePath.length + 6, 4);
        adbClient._writePacket(adbCommands.WRTE, shell._localId, shell._remoteId, sendBuffer);
        adbClient._writePacket(adbCommands.WRTE, shell._localId, shell._remoteId, Buffer.from(`${remotePath},33261`));

        for (let offset = 0; offset < data.length; offset += 1420) {
          const chunk = data.slice(offset, offset + 1420);
          const buffer = Buffer.alloc(8 + chunk.length);
          buffer.write("DATA", 0);
          buffer.writeUInt32LE(chunk.length, 4);
          chunk.copy(buffer, 8);
          adbClient._writePacket(adbCommands.WRTE, shell._localId, shell._remoteId, buffer);
        }

        const doneData = Buffer.alloc(8);
        doneData.write("DONE", 0);
        doneData.writeUInt32LE(Math.floor(Date.now() / 1000), 4);
        adbClient._writePacket(adbCommands.WRTE, shell._localId, shell._remoteId, doneData);

        const quitData = Buffer.alloc(8);
        quitData.write("QUIT", 0);
        adbClient._writePacket(adbCommands.WRTE, shell._localId, shell._remoteId, quitData);

        finish();
      } catch (error) {
        finish(error);
      }
    }, 100);
  });
}

async function pushSamsungFile(event, transport, localPath, remotePath) {
  if (transport.type === "adb") {
    emit(event, { type: "command", text: `$ adbhost push ${localPath} ${remotePath}` });
    await pushFileAdb(transport.adbClient, remotePath, fs.readFileSync(localPath));
    return;
  }

  await runCommand(event, transport.sdb, ["-s", transport.target, "push", localPath, remotePath]);
}

async function verifySamsungRemotePackage(event, transport, localPath, remotePath) {
  const expectedSize = fs.statSync(localPath).size;
  let output = "";
  try {
    output = await runSamsungShell(event, transport, ["ls", "-l", remotePath], {
      idleAfterDataMs: 800,
      noOutputSuccessMs: transport.type === "adb" ? 2500 : 0,
      timeoutMs: 10000
    });
  } catch (error) {
    if (isSamsungShellClosedError(error)) {
      emit(event, {
        type: "info",
        text: "Samsung package upload check was closed by the TV; continuing because the push command completed."
      });
      return;
    }
    throw error;
  }

  if (isSamsungShellClosedOutput(output)) {
    emit(event, {
      type: "info",
      text: "Samsung package upload check was closed by the TV; continuing because the push command completed."
    });
    return;
  }

  const remoteSize = Number(String(output || "").trim().split(/\s+/)[4] || 0);

  if (!remoteSize && transport.type === "adb") {
    emit(event, {
      type: "info",
      text: "Samsung package upload check did not return ls output on direct connection; continuing because adbhost push completed."
    });
    return;
  }

  if (!remoteSize || remoteSize !== expectedSize) {
    throw new Error(`Samsung package upload failed: remote size ${remoteSize || "unknown"}, expected ${expectedSize}.`);
  }

  emit(event, { type: "info", text: `Samsung package uploaded correctly (${remoteSize} bytes).` });
}

function isSamsungCertificateRejection(value) {
  if (isSamsungPlatformIncompatibility(value)) {
    return false;
  }
  const output = String(value?.stdout || "") + "\n" + String(value?.stderr || "") + "\n" + String(value?.message || value || "");
  return /install failed\s*\[\s*(?:118012|118(?:\s*,[^\]]*)?)\s*\]/i.test(output)
    || /check certificate error/i.test(output)
    || /invalid certificate chain/i.test(output)
    || /Samsung TV rejected the signed package/i.test(output);
}

function isSamsungPlatformIncompatibility(value) {
  if (value?.code === "SAMSUNG_UNSUPPORTED_PLATFORM") {
    return true;
  }
  const output = String(value?.stdout || "") + "\n" + String(value?.stderr || "") + "\n" + String(value?.message || value || "");
  return /install failed\s*\[\s*(?:118019|118\s*,\s*-?19)\s*\]/i.test(output);
}

function parseTizenVersion(value) {
  const match = String(value || "").match(/\b(\d+)(?:\.(\d+))?(?:\.(\d+))?\b/);
  if (!match) {
    return [];
  }
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareTizenVersions(left, right) {
  const leftParts = parseTizenVersion(left);
  const rightParts = parseTizenVersion(right);
  if (leftParts.length === 0 || rightParts.length === 0) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

function extractSamsungPlatformVersion(output) {
  const match = String(output || "").match(/(?:^|\n)\s*platform_version\s*[:=]\s*([^\s\r\n]+)/i);
  return match ? match[1].trim() : "";
}

async function readSamsungPlatformVersion(event, transport) {
  try {
    const result = transport.type === "sdb"
      ? await captureCommand(event, transport.sdb, ["-s", transport.target, "capability"], { timeoutMs: 10000 })
      : await captureSamsungShell(event, transport, ["0", "capability"], { timeoutMs: 10000 });
    return extractSamsungPlatformVersion(result.stdout);
  } catch (error) {
    emit(event, {
      type: "info",
      text: `Samsung platform capability check was unavailable; continuing with package validation. ${error?.message || String(error)}`
    });
    return "";
  }
}

async function validateSamsungPlatformVersion(event, transport, requiredVersion) {
  if (!requiredVersion) {
    return;
  }

  const actualVersion = await readSamsungPlatformVersion(event, transport);
  if (!actualVersion) {
    emit(event, {
      type: "info",
      text: "Samsung TV did not expose platform_version; the installer will continue without guessing the TV version."
    });
    return;
  }

  if (compareTizenVersions(actualVersion, requiredVersion) < 0) {
    throw samsungPlatformIncompatibilityError(requiredVersion, actualVersion);
  }

  emit(event, { type: "info", text: `Samsung TV reports Tizen ${actualVersion}; package requires Tizen ${requiredVersion} or later.` });
}

function samsungPlatformIncompatibilityError(requiredVersion = "", actualVersion = "") {
  const modelRange = requiredVersion === "5.0" ? " (Samsung TVs from 2019 onward)" : "";
  const requirement = requiredVersion
    ? `This package requires Tizen ${requiredVersion} or later${modelRange}. `
    : "This package requires a newer Samsung Tizen version. ";
  const detected = actualVersion ? ` The TV reported Tizen ${actualVersion}.` : "";
  const error = new Error(
    "This Samsung TV is not compatible with this Nuvio package. " +
    requirement +
    `The standalone WGT was not installed.${detected}`
  );
  error.code = "SAMSUNG_UNSUPPORTED_PLATFORM";
  return error;
}

function throwIfSamsungOutputFailed(output, context) {
  const normalizedOutput = String(output || "");
  const failedLine = normalizedOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /install failed|uninstall failed|download failed|check certificate error|invalid certificate chain|error/i.test(line) || line.toLowerCase() === "closed");

  if (failedLine) {
    if (failedLine.toLowerCase() === "closed") {
      throw new Error(`${context}: Samsung TV closed the shell command before installation completed.`);
    }
    if (isSamsungCertificateRejection(normalizedOutput)) {
      throw new Error(
        `${context}: ${failedLine}\n\nSamsung TV rejected the signed package. ` +
        "The installer will retry any previous signing identities saved for this TV DUID. " +
        "The failure can indicate an invalid certificate chain, a DUID mismatch, or a signing profile with insufficient privileges."
      );
    }
    throw new Error(`${context}: ${failedLine}`);
  }
}

const samsungPackageCommandCompletePattern = /spend time|install failed|uninstall failed|download failed|check certificate error|invalid certificate chain/i;

function getSamsungCertificateDirectory(userDataPath = app.getPath("userData")) {
  return path.join(userDataPath, "samsung-certificates");
}

async function copyLegacySamsungCertificateStore(sourceDirectory, targetDirectory) {
  let entries;
  try {
    entries = await fsp.readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  const certificateEntries = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
  if (certificateEntries.length === 0) {
    return 0;
  }

  await fsp.mkdir(targetDirectory, { recursive: true });
  let copiedCount = 0;
  for (const entry of certificateEntries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, `legacy-${entry.name}`);
    try {
      await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(targetPath, 0o600).catch(() => {});
      copiedCount += 1;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }

  return copiedCount;
}

async function migrateLegacySamsungCertificateStore() {
  const currentUserDataPath = path.resolve(app.getPath("userData"));
  const targetDirectory = getSamsungCertificateDirectory(currentUserDataPath);
  let copiedCount = 0;

  for (const legacyUserDataName of legacyUserDataNames) {
    const legacyUserDataPath = path.resolve(app.getPath("appData"), legacyUserDataName);
    if (legacyUserDataPath === currentUserDataPath) {
      continue;
    }

    try {
      copiedCount += await copyLegacySamsungCertificateStore(
        getSamsungCertificateDirectory(legacyUserDataPath),
        targetDirectory
      );
    } catch (error) {
      console.warn(`Unable to migrate Samsung certificates from ${legacyUserDataPath}: ${error?.message || String(error)}`);
    }
  }

  migratedLegacySamsungCertificateCount = copiedCount;
  return copiedCount;
}

function getSamsungCertificateConfigPath(target) {
  const safeTarget = String(target || "default").replace(/[^a-z0-9_.-]+/gi, "_");
  return path.join(getSamsungCertificateDirectory(), `${safeTarget}.json`);
}

function getSamsungCertificateDuidConfigPath(duid) {
  const duidHash = crypto.createHash("sha256").update(String(duid || "")).digest("hex");
  return path.join(getSamsungCertificateDirectory(), `duid-${duidHash}.json`);
}

function getSamsungCertificateFingerprint(certificateConfig) {
  const authorCert = String(certificateConfig?.authorCert || "");
  if (!authorCert) {
    return "";
  }
  return crypto.createHash("sha256").update(authorCert).digest("hex");
}

function isUsableSamsungCertificateConfig(certificateConfig, duid = "") {
  return Boolean(
    certificateConfig?.authorCert
    && certificateConfig?.distributorCert
    && certificateConfig?.password
    && (!duid || certificateConfig?.duid === duid)
  );
}

async function readSamsungCertificateConfigFile(configPath) {
  try {
    return JSON.parse(await fsp.readFile(configPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeSamsungCertificateConfigFile(configPath, certificateConfig) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify(certificateConfig, null, 2), { mode: 0o600 });
  await fsp.rename(temporaryPath, configPath);
  await fsp.chmod(configPath, 0o600).catch(() => {});
}

async function readSamsungCertificateConfig(target) {
  return readSamsungCertificateConfigFile(getSamsungCertificateConfigPath(target));
}

async function writeSamsungCertificateConfig(target, certificateConfig) {
  await writeSamsungCertificateConfigFile(getSamsungCertificateConfigPath(target), certificateConfig);
}

async function writeSamsungCertificateConfigForDuid(duid, certificateConfig) {
  await writeSamsungCertificateConfigFile(getSamsungCertificateDuidConfigPath(duid), certificateConfig);
}

async function readSamsungCertificateCandidates(duid, target) {
  const certificateDirectory = getSamsungCertificateDirectory();
  let configPaths = [];
  try {
    configPaths = (await fsp.readdir(certificateDirectory))
      .filter((entry) => entry.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(certificateDirectory, entry));
  } catch {
    return [];
  }

  const canonicalPath = getSamsungCertificateDuidConfigPath(duid);
  const targetPath = getSamsungCertificateConfigPath(target);
  const candidates = [];
  for (const configPath of configPaths) {
    const certificateConfig = await readSamsungCertificateConfigFile(configPath);
    if (!isUsableSamsungCertificateConfig(certificateConfig, duid)) {
      continue;
    }
    await fsp.chmod(configPath, 0o600).catch(() => {});
    candidates.push({
      certificateConfig,
      configPath,
      priority: configPath === canonicalPath ? 0 : (configPath === targetPath ? 1 : 2),
      createdAt: Date.parse(certificateConfig.createdAt || "") || 0
    });
  }

  candidates.sort((left, right) => left.priority - right.priority || right.createdAt - left.createdAt);
  const seenFingerprints = new Set();
  return candidates.filter((candidate) => {
    const fingerprint = getSamsungCertificateFingerprint(candidate.certificateConfig);
    if (!fingerprint || seenFingerprints.has(fingerprint)) {
      return false;
    }
    seenFingerprints.add(fingerprint);
    return true;
  });
}

function samsungAccessInfoHtml(status = "waiting") {
  const isDone = status === "done";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nuvio Samsung Login</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme: dark; --bg: #0d0d0d; --panel: rgba(24,24,24,0.72); --border: rgba(255,255,255,0.1); --text: #fff; --muted: #a8a8a8; --success: #34d399; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: radial-gradient(circle at 18% 12%, rgba(255,255,255,0.08), transparent 32%), radial-gradient(circle at 82% 78%, rgba(52,211,153,0.08), transparent 30%), var(--bg); display: grid; place-items: center; overflow: hidden; }
    body::before { content: ""; position: fixed; inset: 0; background-image: linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px); background-size: 52px 52px; mask-image: radial-gradient(circle at center, #000 0 48%, transparent 76%); pointer-events: none; }
    main { position: relative; width: min(680px, calc(100vw - 40px)); padding: 42px; border: 1px solid var(--border); border-radius: 28px; background: linear-gradient(180deg, rgba(255,255,255,0.08), transparent 34%), var(--panel); box-shadow: 0 28px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.12); backdrop-filter: blur(28px); }
    .brand { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 34px; }
    .mark { width: 12px; height: 12px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 8px rgba(52,211,153,0.12), 0 0 34px rgba(52,211,153,0.46); }
    .status { display: inline-flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid rgba(52,211,153,0.28); border-radius: 999px; color: var(--success); background: rgba(52,211,153,0.08); font-size: 13px; font-weight: 700; margin-bottom: 18px; }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: pulse 1.4s ease-in-out infinite; }
    h1 { margin: 0; max-width: 560px; font-size: clamp(34px, 7vw, 58px); line-height: 0.95; letter-spacing: -0.055em; font-weight: 500; }
    p { margin: 20px 0 0; max-width: 520px; color: var(--muted); font-size: 17px; line-height: 1.6; }
    .rail { margin-top: 34px; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.38), transparent); }
    .hint { margin-top: 22px; color: #d7d7d7; font-size: 14px; }
    @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.8); opacity: 0.35; } }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark"></span>Nuvio Installer</div>
    <div class="status"><span class="pulse"></span>${isDone ? "Authorized" : "Waiting for Samsung"}</div>
    <h1>${isDone ? "Samsung authorization complete" : "Samsung authorization in progress"}</h1>
    <p>${isDone ? "You can close this window and return to the Nuvio installer. The process will continue automatically." : "Complete the Samsung login in the opened window. The Nuvio installer will receive authorization automatically."}</p>
    <div class="rail"></div>
    <div class="hint">${isDone ? "Certificate generation is continuing in the desktop app." : "Keep this page open until authorization finishes."}</div>
  </main>
</body>
</html>`;
}

function parseSamsungAccessInfo(rawValue) {
  if (!rawValue) {
    return null;
  }

  if (typeof rawValue === "object") {
    return rawValue;
  }

  const value = String(rawValue).trim();
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {}

  const parsed = querystring.parse(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function extractSamsungAccessInfoFromRequest(request, body = "") {
  const url = new URL(request.url, "http://127.0.0.1:4794");
  const queryInfo = parseSamsungAccessInfo(url.searchParams.get("code") || url.searchParams.get("accessInfo"));
  if (queryInfo) {
    return queryInfo;
  }

  const queryObject = Object.fromEntries(url.searchParams.entries());
  if (queryObject.access_token || queryObject.accessToken) {
    return queryObject;
  }

  const formBody = querystring.parse(body);
  return parseSamsungAccessInfo(formBody.code || formBody.accessInfo) || formBody;
}

function hasSamsungAccessInfo(accessInfo) {
  return Boolean(accessInfo && (accessInfo.access_token || accessInfo.accessToken));
}

function waitForSamsungAccessInfo(event) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let server;

    function finish(accessInfo, response) {
      if (settled) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(samsungAccessInfoHtml("done"));
        return;
      }

      settled = true;
      clearTimeout(timeout);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(samsungAccessInfoHtml("done"));
      server.close();
      resolve(accessInfo);
    }

    const timeout = setTimeout(() => {
      if (server) {
        server.close();
      }
      reject(new Error("Samsung login timed out. Try the installation again and complete the login within 5 minutes."));
    }, 5 * 60 * 1000);

    server = http.createServer((request, response) => {
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          try {
            const accessInfo = extractSamsungAccessInfoFromRequest(request, body);
            if (!hasSamsungAccessInfo(accessInfo)) {
              response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              response.end(samsungAccessInfoHtml());
              return;
            }
            finish(accessInfo, response);
          } catch (error) {
            response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            response.end(samsungAccessInfoHtml());
          }
        });
        return;
      }

      const accessInfo = extractSamsungAccessInfoFromRequest(request);
      if (hasSamsungAccessInfo(accessInfo)) {
        finish(accessInfo, response);
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(samsungAccessInfoHtml());
    });

    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Unable to open the local Samsung server on port 4794: ${error.message}`));
    });

    server.listen(4794, "127.0.0.1", () => {
      const authUrl = "https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h&actionID=StartOAuth2&accessToken=Y&redirect_uri=http://localhost:4794/signin/callback";
      emit(event, { type: "info", text: "Opening Samsung login. Complete sign-in in the browser, then return to the installer." });
      shell.openExternal(authUrl);
    });
  });
}

async function getSamsungDuid(event, transport) {
  const result = await captureSamsungShell(event, transport, ["0", "getduid"], { timeoutMs: 10000 });
  const duid = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!duid) {
    throw new Error("Unable to read the Samsung TV DUID.");
  }
  emit(event, { type: "info", text: `Detected Samsung DUID: ${duid}` });
  return duid;
}

async function createSamsungCertificateForTarget(event, transport, knownDuid = "") {
  const duid = knownDuid || await getSamsungDuid(event, transport);
  const accessInfo = await waitForSamsungAccessInfo(event);
  const accessToken = accessInfo.access_token || accessInfo.accessToken;
  const userId = accessInfo.userId || accessInfo.user_id;
  if (!accessToken || !userId) {
    throw new Error("Samsung did not return valid authorization data. Try signing in again.");
  }
  const password = crypto.randomBytes(18).toString("base64url");
  const authorInfo = {
    name: "Nuvio",
    email: accessInfo.inputEmailID || accessInfo.email || userId,
    password,
    privilegeLevel: "Partner"
  };

  emit(event, { type: "info", text: "Creating the Samsung certificate for this TV. This may take 30-60 seconds." });
  const creator = new SamsungCertificateCreator();
  const certificate = await creator.createCertificate(authorInfo, {
    accessToken,
    userId
  }, [duid]);

  if (!certificate.authorCert || !certificate.distributorCert) {
    throw new Error("Samsung did not return a valid certificate.");
  }

  const certificateConfig = {
    authorCert: Buffer.from(certificate.authorCert, "binary").toString("base64"),
    distributorCert: Buffer.from(certificate.distributorCert, "binary").toString("base64"),
    distributorXML: certificate.distributorXML ? Buffer.from(certificate.distributorXML, "utf8").toString("base64") : "",
    password,
    duid,
    createdAt: new Date().toISOString()
  };

  await writeSamsungCertificateConfigForDuid(duid, certificateConfig);
  await writeSamsungCertificateConfig(transport.target, certificateConfig);

  if (certificate.distributorXML) {
    const profilePath = path.join(app.getPath("userData"), "samsung-certificates", `${String(transport.target).replace(/[^a-z0-9_.-]+/gi, "_")}-device-profile.xml`);
    await fsp.writeFile(profilePath, certificate.distributorXML, "utf8");
    try {
      await ensureSamsungTempDirectory(event, transport);
      await pushSamsungFile(event, transport, profilePath, "/home/owner/share/tmp/sdk_tools/device-profile.xml");
    } catch (error) {
      emit(event, {
        type: "info",
        text: `Skipping Samsung device profile upload because the TV rejected the helper path: ${error?.message || String(error)}`
      });
    }
  }

  emit(event, { type: "success", text: "Samsung certificate created and saved for this TV." });
  return certificateConfig;
}

async function readManualSamsungCertificateConfig(options) {
  const manual = options?.samsungCert;
  if (!manual || manual.auto !== false) {
    return null;
  }

  const profileName = String(manual.profileName || "").trim();
  if (profileName) {
    return {
      authorCert: "",
      distributorCert: "",
      distributorXML: "",
      password: "",
      profileName,
      duid: "",
      createdAt: new Date().toISOString()
    };
  }

  const authorPath = requireValue(manual.authorPath, "Samsung author certificate");
  const distributorPath = requireValue(manual.distributorPath, "Samsung distributor certificate");
  const password = requireValue(manual.password, "Samsung certificate password");

  return {
    authorCert: (await fsp.readFile(authorPath)).toString("base64"),
    distributorCert: (await fsp.readFile(distributorPath)).toString("base64"),
    distributorXML: "",
    password,
    profileName: "",
    duid: "",
    createdAt: new Date().toISOString()
  };
}

async function getSamsungCertificateCandidates(event, transport, options = {}) {
  const manualCertificate = await readManualSamsungCertificateConfig(options);
  if (manualCertificate) {
    emit(event, { type: "info", text: "Using the Samsung certificates selected manually." });
    return {
      duid: "",
      candidates: [{ certificateConfig: manualCertificate, configPath: "", priority: 0, createdAt: Date.now() }]
    };
  }

  const duid = await getSamsungDuid(event, transport);
  if (migratedLegacySamsungCertificateCount > 0) {
    emit(event, {
      type: "info",
      text: `Recovered ${migratedLegacySamsungCertificateCount} Samsung signing identity file${migratedLegacySamsungCertificateCount === 1 ? "" : "s"} from the previous Nuvio WebTV Installer data folder.`
    });
  }
  const candidates = await readSamsungCertificateCandidates(duid, transport.target);
  if (candidates.length > 0) {
    emit(event, {
      type: "info",
      text: candidates.length === 1
        ? "Using the Samsung certificate already saved for this TV DUID."
        : `Found ${candidates.length} saved Samsung signing identities for this TV DUID; previous identities will be available for update recovery.`
    });
    return { duid, candidates };
  }

  const existing = await readSamsungCertificateConfig(transport.target);
  if (existing?.duid && existing.duid !== duid) {
    emit(event, { type: "info", text: "Saved Samsung certificate belongs to a different TV, creating a new one." });
  }
  const certificateConfig = await createSamsungCertificateForTarget(event, transport, duid);
  return {
    duid,
    candidates: [{
      certificateConfig,
      configPath: getSamsungCertificateDuidConfigPath(duid),
      priority: 0,
      createdAt: Date.parse(certificateConfig.createdAt || "") || Date.now()
    }]
  };
}

async function parseTizenPackageMetadata(packagePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const configFile = zip.files["config.xml"];
  const manifestFile = zip.files["tizen-manifest.xml"];

  if (configFile) {
    const xml = await configFile.async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const application = doc.getElementsByTagName("tizen:application")[0]
      || doc.getElementsByTagNameNS("http://tizen.org/ns/widgets", "application")[0];
    if (!application) {
      throw new Error("config.xml does not contain tizen:application.");
    }
    return {
      packageId: application.getAttribute("package") || "",
      appId: application.getAttribute("id") || "",
      requiredVersion: application.getAttribute("required_version") || "",
      extension: "wgt"
    };
  }

  if (manifestFile) {
    const xml = await manifestFile.async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const manifest = doc.getElementsByTagName("manifest")[0];
    return {
      packageId: manifest?.getAttribute("package") || "",
      appId: manifest?.getAttribute("package") || "",
      requiredVersion: "",
      extension: "tpk"
    };
  }

  throw new Error("Invalid Tizen package: config.xml or tizen-manifest.xml is missing.");
}

function isValidSamsungPackageId(packageId) {
  return /^[A-Za-z0-9]{10}$/.test(String(packageId || ""));
}

function elementsByTagName(doc, tagName, namespaceUri, localName) {
  const elements = Array.from(doc.getElementsByTagName(tagName));
  try {
    elements.push(...Array.from(doc.getElementsByTagNameNS(namespaceUri, localName)));
  } catch {}

  return Array.from(new Set(elements));
}

async function validateSamsungEngineFsWebServicePackage(event, packagePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const configFile = zip.files["config.xml"];
  const mainFile = zip.files["main.js"];
  const missing = [];

  if (!configFile) {
    throw new Error("Invalid Samsung WGT: config.xml is missing.");
  }

  if (!mainFile || mainFile.dir) {
    missing.push("main.js");
  }

  [tizenEngineFsServicePath, ...tizenEngineFsRuntimePaths].forEach((filename) => {
    if (!zip.files[filename] || zip.files[filename].dir) {
      missing.push(filename);
    }
  });

  const engineFsServiceEntry = zip.files[tizenEngineFsServicePath];
  const engineFsServiceSource = engineFsServiceEntry && !engineFsServiceEntry.dir
    ? await engineFsServiceEntry.async("string")
    : "";
  if (!new RegExp(
    `process\\.env\\.PORT\\s*=\\s*process\\.env\\.PORT\\s*\\|\\|\\s*["']${tizenEngineFsServicePort}["']`
  ).test(engineFsServiceSource)) {
    missing.push(`EngineFS fixed port ${tizenEngineFsServicePort}`);
  }
  if (/11470|11471|FALLBACK_PORT|candidateIndex/.test(engineFsServiceSource)) {
    missing.push("EngineFS fallback port logic");
  }

  const xml = await configFile.async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const features = elementsByTagName(doc, "feature", "http://www.w3.org/ns/widgets", "feature");
  const hasWebServiceFeature = features.some((feature) => (
    feature.getAttribute("name") === "http://tizen.org/feature/web.service"
  ));

  if (!hasWebServiceFeature) {
    missing.push("config.xml feature http://tizen.org/feature/web.service");
  }

  const services = elementsByTagName(doc, "tizen:service", "http://tizen.org/ns/widgets", "service");
  const hasEngineFsService = services.some((service) => {
    const contents = elementsByTagName(service, "tizen:content", "http://tizen.org/ns/widgets", "content");
    return contents.some((content) => content.getAttribute("src") === tizenEngineFsServicePath);
  });

  if (!hasEngineFsService) {
    missing.push(`config.xml tizen:service -> ${tizenEngineFsServicePath}`);
  }

  if (missing.length > 0) {
    throw new Error(`Samsung WGT is missing the local Tizen P2P Web Service: ${missing.join(", ")}.`);
  }

  emit(event, { type: "info", text: "Samsung WGT includes the local Tizen P2P Web Service." });
}

async function validateSamsungPluginWebServicePackage(event, packagePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const configFile = zip.files["config.xml"];
  const mainFile = zip.files["main.js"];
  if (!configFile || !mainFile || mainFile.dir) {
    throw new Error("Invalid Samsung WGT: config.xml and main.js are required for local Tizen services.");
  }

  const mainJs = await mainFile.async("string");
  const pluginBridgePath = "services/tizen/wrt-service-bridge.js";
  const pluginServiceEntry = zip.files[tizenPluginServicePath];
  const pluginHttpEntry = zip.files[tizenPluginServiceSourcePath];
  const pluginBridgeEntry = zip.files[pluginBridgePath];
  const hasPluginFiles = [pluginServiceEntry, pluginHttpEntry].some(
    (entry) => entry && !entry.dir
  );
  const hasLegacyPluginBridge = pluginBridgeEntry && !pluginBridgeEntry.dir;
  const pluginEnabled = /__NUVIO_TIZEN_PLUGIN_SERVICE_ENABLED__\s*=\s*true\b/.test(mainJs);
  if (!pluginEnabled && !hasPluginFiles && !hasLegacyPluginBridge) {
    return;
  }

  const missing = [];
  if (!pluginServiceEntry || pluginServiceEntry.dir) {
    missing.push(tizenPluginServicePath);
  }

  const pluginServiceSource = pluginServiceEntry && !pluginServiceEntry.dir
    ? await pluginServiceEntry.async("string")
    : "";
  if (!pluginHttpEntry || pluginHttpEntry.dir) {
    missing.push(tizenPluginServiceSourcePath);
  }
  if (!pluginServiceSource.includes('require("../plugin-http.cjs")')) {
    missing.push("PluginService canonical relative plugin-http loader");
  }
  if (!pluginServiceSource.includes(`var DEFAULT_PORT = ${tizenPluginServicePort};`)) {
    missing.push(`PluginService fixed port ${tizenPluginServicePort}`);
  }
  if (/11470|11471|FALLBACK_PORT|candidateIndex/.test(pluginServiceSource)) {
    missing.push("PluginService fallback port logic");
  }

  const xml = await configFile.async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const application = doc.getElementsByTagName("tizen:application")[0]
    || doc.getElementsByTagNameNS("http://tizen.org/ns/widgets", "application")[0];
  const packageId = application?.getAttribute("package") || "";
  const pluginServiceId = packageId ? `${packageId}.PluginService` : "";
  const features = elementsByTagName(doc, "feature", "http://www.w3.org/ns/widgets", "feature");
  if (!features.some((feature) => feature.getAttribute("name") === "http://tizen.org/feature/web.service")) {
    missing.push("config.xml feature http://tizen.org/feature/web.service");
  }

  const privileges = elementsByTagName(doc, "tizen:privilege", "http://tizen.org/ns/widgets", "privilege");
  if (!privileges.some((privilege) => privilege.getAttribute("name") === "http://tizen.org/privilege/application.launch")) {
    missing.push("config.xml privilege http://tizen.org/privilege/application.launch");
  }

  const services = elementsByTagName(doc, "tizen:service", "http://tizen.org/ns/widgets", "service");
  const declaredPluginService = services.find((service) => {
    const contents = elementsByTagName(service, "tizen:content", "http://tizen.org/ns/widgets", "content");
    return service.getAttribute("id") === pluginServiceId
      && contents.some((content) => content.getAttribute("src") === tizenPluginServicePath);
  });
  if (!declaredPluginService) {
    missing.push(`config.xml tizen:service -> ${pluginServiceId || "<package>.PluginService"}`);
  }

  const indexHtml = await zip.files["index.html"]?.async("string") || "";
  const hasInlineWrtServiceBridge = /<script\b[^>]*\btype=["']module["'][^>]*>[\s\S]*?\bimport\s+\*\s+as\s+service\s+from\s+["']wrt:service["']\s*;?/i.test(indexHtml);
  if (!hasInlineWrtServiceBridge) {
    missing.push("index.html wrt:service module bridge");
  }
  if (pluginBridgeEntry && !pluginBridgeEntry.dir) {
    missing.push(`${pluginBridgePath} must not be packaged; use the inline wrt:service bridge`);
  }
  if (!/__NUVIO_TIZEN_PLUGIN_SERVICE_ENABLED__\s*=\s*true\b/.test(mainJs)) {
    missing.push("main.js PluginService enable flag");
  }
  const declaredPluginServiceId = declaredPluginService?.getAttribute("id") || "";
  if (!pluginServiceId || !mainJs.includes(JSON.stringify(pluginServiceId))) {
    missing.push(`main.js PluginService id ${declaredPluginServiceId || pluginServiceId || "<package>.PluginService"}`);
  }

  for (const obsoletePath of [
    "services/tizen/plugin-http.cjs",
    "assets/libs/quickjs-emscripten-legacy.global.js",
    "assets/libs/quickjs-emscripten-legacy.LICENSE"
  ]) {
    const obsoleteEntry = zip.files[obsoletePath];
    if (obsoleteEntry && !obsoleteEntry.dir) {
      missing.push(`${obsoletePath} must not be packaged`);
    }
  }

  const engineFsFile = zip.files[tizenEngineFsServicePath];
  if (engineFsFile && /require\(["']\.\/plugin-service\.js["']\)/.test(await engineFsFile.async("string"))) {
    missing.push("independent EngineFS and PluginService lifecycles");
  }

  if (missing.length > 0) {
    throw new Error(`Samsung WGT is missing the local Tizen Plugin Web Service contract: ${missing.join(", ")}.`);
  }

  emit(event, {
    type: "info",
    text: "Samsung WGT includes the canonical local Tizen Plugin Web Service contract (external helper and inline wrt:service bridge)."
  });
}

async function normalizeSamsungPackageMetadata(event, packagePath) {
  const targetPackageId = String(config.tizen.packageId || "").trim();
  const targetAppId = String(config.tizen.appId || "").trim();

  if (!isValidSamsungPackageId(targetPackageId) || !targetAppId.startsWith(`${targetPackageId}.`)) {
    return packagePath;
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const configFile = zip.files["config.xml"];
  if (!configFile) {
    return packagePath;
  }

  const xml = await configFile.async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const application = doc.getElementsByTagName("tizen:application")[0]
    || doc.getElementsByTagNameNS("http://tizen.org/ns/widgets", "application")[0];

  if (!application) {
    return packagePath;
  }

  const currentPackageId = application.getAttribute("package") || "";
  const currentAppId = application.getAttribute("id") || "";
  if (isValidSamsungPackageId(currentPackageId) && currentAppId.startsWith(`${currentPackageId}.`)) {
    return packagePath;
  }

  application.setAttribute("package", targetPackageId);
  application.setAttribute("id", targetAppId);

  const outputDir = path.join(app.getPath("userData"), "prepared");
  await fsp.mkdir(outputDir, { recursive: true });
  const parsed = path.parse(packagePath);
  const normalizedPath = path.join(outputDir, `${parsed.name}-samsung-normalized-${Date.now()}${parsed.ext || ".wgt"}`);

  zip.file("config.xml", new XMLSerializer().serializeToString(doc));
  await fsp.writeFile(normalizedPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  emit(event, { type: "info", text: `Normalized Samsung package id: ${currentPackageId || "(empty)"} -> ${targetPackageId}` });
  return normalizedPath;
}

function parseVdAppList(output) {
  return String(output || "")
    .split("---------------------------------------------------------------------------------------------")
    .map((entry) => entry
      .replace(/--------------/g, "")
      .replace(/-------------/g, "")
      .replace(/\s+=/g, "=")
      .replace(/\r/g, "")
      .trim())
    .filter(Boolean)
    .map((entry) => {
      const app = {};
      entry.split(/\n/).forEach((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex <= 0) {
          return;
        }
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        app[key] = value;
      });
      return app;
    })
    .filter((app) => Object.keys(app).length > 0);
}

function tizenIdentifierCandidates(...values) {
  return Array.from(new Set(values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

async function listSamsungApps(event, transport) {
  const result = await captureSamsungShell(event, transport, ["0", "vd_applist"]);
  return parseVdAppList(result.stdout);
}

async function findSamsungInstalledApp(event, transport, identifiers) {
  const candidates = tizenIdentifierCandidates(identifiers);
  if (candidates.length === 0) {
    return null;
  }

  const apps = await listSamsungApps(event, transport);
  return apps.find((app) => [
    app.app_id,
    app.app_tizen_id,
    app.app_package_id,
    app.package_id
  ].some((value) => candidates.includes(String(value || "").trim()))) || null;
}

async function resignTizenPackageWithSamsungCertificate(event, packagePath, certificateConfig) {
  if (certificateConfig?.profileName) {
    return signTizenPackageWithStudioProfile(event, packagePath, certificateConfig.profileName);
  }

  emit(event, { type: "info", text: "Automatically signing the WGT with the saved Samsung certificate." });

  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const unsignedFiles = await Promise.all(Object.keys(zip.files).map(async (filename) => {
    const file = zip.files[filename];
    if (file.dir || filename === "author-signature.xml" || filename === "signature1.xml") {
      return null;
    }
    return {
      uri: encodeURIComponent(filename),
      data: await file.async("nodebuffer")
    };
  }));

  const authorDer = forge.util.createBuffer(Buffer.from(certificateConfig.authorCert, "base64").toString("binary"));
  const distributorDer = forge.util.createBuffer(Buffer.from(certificateConfig.distributorCert, "base64").toString("binary"));
  const authorKey = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(authorDer), false, certificateConfig.password);
  const distributorKey = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(distributorDer), false, certificateConfig.password);

  const authorSignature = new Signature("AuthorSignature", unsignedFiles.filter(Boolean));
  const authorFiles = await authorSignature.sign(authorKey);
  const distributorSignature = new Signature("DistributorSignature", authorFiles);
  const distributorFiles = await distributorSignature.sign(distributorKey);

  const outputZip = new JSZip();
  distributorFiles.forEach((file) => {
    outputZip.file(decodeURIComponent(file.uri), file.data);
  });

  const outputDir = path.join(app.getPath("userData"), "resigned");
  await fsp.mkdir(outputDir, { recursive: true });
  const parsed = path.parse(packagePath);
  const resignedPackage = path.join(outputDir, `${parsed.name}-samsung-signed-${Date.now()}${parsed.ext || ".wgt"}`);
  const zipData = await outputZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fsp.writeFile(resignedPackage, zipData);

  emit(event, { type: "info", text: `Automatically signed WGT: ${resignedPackage}` });
  return resignedPackage;
}

async function signTizenPackageWithStudioProfile(event, packagePath, profileName) {
  const tizen = await resolveCommand("tizen");
  if (!tizen) {
    throw new Error("Tizen Studio CLI was not found. Install Tizen Studio or leave the profile name empty to use the built-in signer.");
  }

  emit(event, { type: "info", text: `Signing WGT with Tizen Studio security profile "${profileName}".` });
  const parsed = path.parse(packagePath);
  const workRoot = path.join(app.getPath("temp"), `nuvio-tizen-sign-${Date.now()}`);
  const unpackDir = path.join(workRoot, "package");
  const outputDir = path.join(workRoot, "out");
  await fsp.mkdir(unpackDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });

  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  await Promise.all(Object.keys(zip.files).map(async (filename) => {
    const file = zip.files[filename];
    if (file.dir || filename === "author-signature.xml" || filename === "signature1.xml") {
      return;
    }
    const targetPath = path.join(unpackDir, filename);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, await file.async("nodebuffer"));
  }));

  await runCommand(event, tizen, ["package", "-t", "wgt", "-s", profileName, "-o", outputDir, "--", unpackDir], {
    cwd: workRoot
  });

  const signedCandidates = (await fsp.readdir(outputDir))
    .filter((entry) => entry.toLowerCase().endsWith(".wgt"))
    .map((entry) => path.join(outputDir, entry));
  if (!signedCandidates.length) {
    throw new Error("Tizen Studio signing completed but no signed WGT was produced.");
  }

  const outputPath = path.join(app.getPath("userData"), "resigned", `${parsed.name}-tizen-studio-signed-${Date.now()}${parsed.ext || ".wgt"}`);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.copyFile(signedCandidates[0], outputPath);
  emit(event, { type: "info", text: `Tizen Studio signed WGT: ${outputPath}` });
  return outputPath;
}

async function prepareSamsungPackage(event, transport, packagePath, options = {}) {
  packagePath = await normalizeSamsungPackageMetadata(event, packagePath);
  const metadata = await parseTizenPackageMetadata(packagePath);
  await validateSamsungPlatformVersion(event, transport, metadata.requiredVersion);
  await validateSamsungEngineFsWebServicePackage(event, packagePath);
  await validateSamsungPluginWebServicePackage(event, packagePath);
  const certificateSelection = await getSamsungCertificateCandidates(event, transport, options);
  return { packagePath, ...certificateSelection };
}

async function markSamsungCertificateInstallSuccessful(event, transport, duid, certificateConfig, metadata) {
  if (!duid || !isUsableSamsungCertificateConfig(certificateConfig, duid)) {
    return;
  }
  const persistedConfig = {
    ...certificateConfig,
    duid,
    lastSuccessfulInstallAt: new Date().toISOString(),
    lastSuccessfulPackageId: String(metadata?.packageId || "")
  };
  try {
    await writeSamsungCertificateConfigForDuid(duid, persistedConfig);
    await writeSamsungCertificateConfig(transport.target, persistedConfig);
    emit(event, { type: "success", text: "Saved the working Samsung signing identity for future updates on this TV DUID." });
  } catch (error) {
    emit(event, {
      type: "error",
      text: `The app was installed, but the working Samsung certificate could not be saved for the next update: ${error?.message || String(error)}`
    });
  }
}

function describeSamsungCertificateCandidate(candidate, index, total) {
  const certificateConfig = candidate?.certificateConfig || {};
  if (certificateConfig.profileName) {
    return `Tizen Studio profile "${certificateConfig.profileName}"`;
  }
  const fingerprint = getSamsungCertificateFingerprint(certificateConfig).slice(0, 12);
  return `saved identity ${index + 1}/${total}${fingerprint ? ` (${fingerprint})` : ""}`;
}

async function installSamsungPackage(event, transport, packagePath) {
  const metadata = await parseTizenPackageMetadata(packagePath);
  const installIds = tizenIdentifierCandidates(metadata.packageId, metadata.appId);
  if (installIds.length === 0) {
    throw new Error("Unable to read the application id or package id from the Tizen package.");
  }

  const remotePath = `/home/owner/share/tmp/sdk_tools/nuvio-package.${metadata.extension}`;
  emit(event, { type: "info", text: `Detected package id: ${metadata.packageId}` });
  if (metadata.appId) {
    emit(event, { type: "info", text: `Detected application id: ${metadata.appId}` });
  }

  const shellSetupAvailable = await ensureSamsungTempDirectory(event, transport);
  if (shellSetupAvailable) {
    const cleanupOutput = await runSamsungShell(event, transport, ["0", "rm", "-f", remotePath], { noOutputSuccessMs: 1500 }).catch((error) => {
      if (isSamsungShellClosedError(error)) {
        return "closed";
      }
      return "";
    });
    if (isSamsungShellClosedOutput(cleanupOutput)) {
      emit(event, {
        type: "info",
        text: "Samsung TV closed the cleanup shell command; continuing because push can overwrite the package."
      });
    }
  }
  await pushSamsungFile(event, transport, packagePath, remotePath);
  await verifySamsungRemotePackage(event, transport, packagePath, remotePath);

  let lastError = null;
  let certificateError = null;
  for (const installId of installIds) {
    try {
      const output = await runSamsungShell(event, transport, ["0", "vd_appinstall", installId, remotePath], {
        completeWhen: samsungPackageCommandCompletePattern,
        timeoutMs: 180000
      });
      throwIfSamsungOutputFailed(output, `vd_appinstall failed with ${installId}`);
      return metadata;
    } catch (error) {
      if (isSamsungPlatformIncompatibility(error)) {
        throw samsungPlatformIncompatibilityError(metadata.requiredVersion);
      }
      if (isSamsungCertificateRejection(error)) {
        // 118012 is also returned when the TV cannot resolve the supplied identifier, so
        // exhaust the id fallback before reporting a certificate rejection.
        certificateError = certificateError || error;
        emit(event, {
          type: "info",
          text: `Samsung rejected ${installId}; trying the next Samsung identifier before reporting a certificate error.`
        });
        continue;
      }
      lastError = error;
      emit(event, {
        type: "error",
        text: `vd_appinstall with ${installId} failed: ${error?.stack || error?.message || String(error)}`
      });
      emit(event, { type: "info", text: "Trying the next Samsung identifier if available." });
    }
  }

  throw certificateError || lastError || new Error("vd_appinstall failed.");
}

async function uninstallSamsungApp(event, transport, identifiers) {
  const candidates = tizenIdentifierCandidates(identifiers);
  const installedApp = await findSamsungInstalledApp(event, transport, candidates).catch(() => null);
  const uninstallIds = tizenIdentifierCandidates(
    installedApp?.app_package_name,
    installedApp?.app_id,
    installedApp?.app_tizen_id,
    installedApp?.app_package_id,
    installedApp?.package_id,
    candidates
  );

  if (transport.type === "adb") {
    throw new Error("Samsung direct uninstall is not reliable on this TV. Install Tizen Studio/sdb for one-click uninstall, or remove Nuvio from the TV apps menu.");
  }

  let lastError = null;
  try {
    await runCommand(event, transport.sdb, ["-s", transport.target, "uninstall", uninstallIds[0] || candidates[0] || config.tizen.appId]);
    return;
  } catch (fallbackError) {
    lastError = fallbackError;
    const tizen = await resolveCommand("tizen");
    if (!tizen) {
      throw fallbackError;
    }
    emit(event, { type: "info", text: "sdb uninstall failed, trying fallback with the tizen CLI found on the system." });
  }

  const tizen = await resolveCommand("tizen");
  if (!tizen) {
    throw lastError || new Error("Samsung uninstall failed and the tizen CLI was not found.");
  }

  for (const uninstallId of uninstallIds) {
    try {
      await runCommand(event, tizen, ["uninstall", "-p", uninstallId, "-t", transport.target]);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Samsung uninstall failed.");
}

async function launchSamsungApp(event, transport, identifiers) {
  const installedApp = await findSamsungInstalledApp(event, transport, identifiers);
  const launchId = installedApp?.app_id || installedApp?.app_tizen_id || tizenIdentifierCandidates(identifiers)[0];
  if (!launchId) {
    throw new Error("Samsung app was not found. Install Nuvio or check appId in installer.config.json.");
  }
  const output = await runSamsungShell(event, transport, ["0", "was_execute", launchId]);
  throwIfSamsungOutputFailed(output, "Samsung app launch failed");
}

async function runSamsung(event, action, options) {
  const ip = requireValue(options.ip, "IP Samsung TV");
  const configuredIds = tizenIdentifierCandidates(config.tizen.appId, config.tizen.packageId, config.tizen.appIds);

  if (action === "uninstall") {
    const transport = await connectSamsungSdbTransport(event, ip);
    await uninstallSamsungApp(event, transport, configuredIds);
    return;
  }

  const transport = await connectSamsungTransport(event, ip);

  try {
    if (action === "launch") {
      await launchSamsungApp(event, transport, configuredIds);
      return;
    }

    const packagePath = options.packagePath || await resolveReleaseAsset(event, "tizen", options.releaseId);
    const preparedPackage = await prepareSamsungPackage(event, transport, packagePath, options);
    let installPackagePath = "";
    let activeCertificateConfig = null;
    let installedMetadata = null;
    let directInstallError = null;

    for (let index = 0; index < preparedPackage.candidates.length; index += 1) {
      const candidate = preparedPackage.candidates[index];
      const candidateDescription = describeSamsungCertificateCandidate(candidate, index, preparedPackage.candidates.length);
      emit(event, { type: "info", text: `Signing Samsung package with ${candidateDescription}.` });

      try {
        installPackagePath = await resignTizenPackageWithSamsungCertificate(
          event,
          preparedPackage.packagePath,
          candidate.certificateConfig
        );
      } catch (error) {
        if (index + 1 < preparedPackage.candidates.length) {
          emit(event, {
            type: "info",
            text: `Could not use ${candidateDescription}; trying the next saved identity. ${error?.message || String(error)}`
          });
          continue;
        }
        throw error;
      }

      activeCertificateConfig = candidate.certificateConfig;
      try {
        installedMetadata = await installSamsungPackage(event, transport, installPackagePath);
        await markSamsungCertificateInstallSuccessful(
          event,
          transport,
          preparedPackage.duid,
          activeCertificateConfig,
          installedMetadata
        );
        directInstallError = null;
        break;
      } catch (error) {
        directInstallError = error;
        if (isSamsungCertificateRejection(error) && index + 1 < preparedPackage.candidates.length) {
          emit(event, {
            type: "info",
            text: `Samsung rejected ${candidateDescription}; retrying with the previous signing identity saved for this TV DUID.`
          });
          continue;
        }
        break;
      }
    }

    if (directInstallError) {
      if (isSamsungPlatformIncompatibility(directInstallError)) {
        throw directInstallError;
      }
      if (isSamsungCertificateRejection(directInstallError)) {
        throw new Error(
          `${directInstallError.message}\n\n` +
          `Tried ${preparedPackage.candidates.length} saved signing ${preparedPackage.candidates.length === 1 ? "identity" : "identities"} for this TV. ` +
          "The TV did not accept any available signing identity. Keep the working author certificate for future updates and, if this is a new installation, verify the Samsung certificate/profile and TV DUID."
        );
      }

      emit(event, {
        type: "error",
        text: `Samsung direct package install failed before fallback: ${directInstallError?.stack || directInstallError?.message || String(directInstallError)}`
      });
      let fallbackTransport = transport;
      let fallbackError = directInstallError;

      try {
        if (fallbackTransport.type !== "sdb") {
          emit(event, { type: "info", text: "vd_appinstall failed on direct connection, trying fallback with sdb install." });
          closeSamsungTransport(fallbackTransport);
          fallbackTransport = await connectSamsungSdbTransport(event, ip);
        } else {
          emit(event, { type: "info", text: "vd_appinstall failed, trying fallback with sdb install." });
        }

        await runCommand(event, fallbackTransport.sdb, ["-s", fallbackTransport.target, "install", installPackagePath]);
        installedMetadata = await parseTizenPackageMetadata(installPackagePath);
        await markSamsungCertificateInstallSuccessful(
          event,
          transport,
          preparedPackage.duid,
          activeCertificateConfig,
          installedMetadata
        );
        fallbackError = null;
      } catch (sdbError) {
        fallbackError = sdbError;
      }

      if (fallbackError) {
        const tizen = await resolveCommand("tizen");
        if (!tizen) {
          throw fallbackError || directInstallError;
        }

        const tizenTarget = fallbackTransport?.type === "sdb" ? fallbackTransport.target : ip;
        emit(event, { type: "info", text: "sdb install failed, trying fallback with the tizen CLI found on the system." });
        await runCommand(event, tizen, ["install", "-n", installPackagePath, "-t", tizenTarget]);
        installedMetadata = await parseTizenPackageMetadata(installPackagePath);
        await markSamsungCertificateInstallSuccessful(
          event,
          transport,
          preparedPackage.duid,
          activeCertificateConfig,
          installedMetadata
        );
      }
    }

    emit(event, {
      type: "info",
      text: "If you want to use debug/autolaunch, set Host PC IP to 127.0.0.1 on the TV after installation."
    });
  } finally {
    closeSamsungTransport(transport);
  }
}

ipcMain.handle("installer:run", async (event, request) => {
  const platform = request.platform;
  const action = request.action;
  emit(event, { type: "info", text: `Starting ${action} on ${platform}.` });

  try {
    if (platform === "lg") {
      await runLg(event, action, request.options || {});
    } else if (platform === "samsung") {
      await runSamsung(event, action, request.options || {});
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    emit(event, { type: "success", text: "Operation completed." });
    return { ok: true };
  } catch (error) {
    emit(event, { type: "error", text: error.message || String(error) });
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle("installer:selectFile", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'TV Packages and Certificates', extensions: ['wgt', 'ipk', 'p12', 'pfx'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (canceled) return null;
  return filePaths[0];
});

ipcMain.handle("installer:getConfig", async () => ({
  repo: config.githubRepo,
  webosAppId: config.webos.appId,
  tizenAppId: config.tizen.appId,
  platform: os.platform(),
  localIps: getLocalIPv4Addresses()
}));

ipcMain.handle("installer:getRecentReleases", async (_event, platform) => getRecentReleases(platform));

ipcMain.handle("installer:getLgDevices", async () => listRegisteredLgDevices());

ipcMain.handle("installer:deleteLgDevice", async (event, deviceName) => {
  const normalizedName = requireValue(deviceName, "LG device name");
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  const confirmation = await dialog.showMessageBox(ownerWindow, {
    type: "warning",
    buttons: ["Cancel", "Delete Device"],
    defaultId: 0,
    cancelId: 0,
    title: "Delete LG Device",
    message: `Delete the saved LG device "${normalizedName}"?`,
    detail: "This removes the device profile from the webOS CLI. You will need the TV IP and Developer Mode passphrase to add it again."
  });

  if (confirmation.response !== 1) {
    return { ok: false, cancelled: true };
  }

  await deleteLgDevice(event, normalizedName);
  return { ok: true };
});

ipcMain.handle("installer:copyText", async (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
