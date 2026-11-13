#!/usr/bin/env node
// Headless, script-friendly entry point. Same install logic as the desktop app (src/main.js).
const path = require("node:path");
const { parseArgs } = require("node:util");

const usage = `Nuvio TV Installer CLI

Usage:
  nuvio-tv-installer <samsung|lg> <install|launch|uninstall> --ip <TV IP> [options]
  nuvio-tv-installer <samsung|lg> releases

Options:
  --ip <address>             TV IP address (required for install/launch/uninstall)
  --release <tag|id>         Release to install (default: latest)
  --file <path>              Install a local .wgt/.ipk instead of downloading
  --device-name <name>       LG: webOS device name
  --passphrase <code>        LG: Developer Mode passphrase (first install only)
  --cert-profile <name>      Samsung: use an existing Tizen Studio security profile
  --author-cert <path>       Samsung: author certificate (.p12)
  --distributor-cert <path>  Samsung: distributor certificate (.p12)
  --cert-password <pass>     Samsung: certificate password (or NUVIO_CERT_PASSWORD)
  --json                     Print one JSON object per log line
  -h, --help                 Show this help

Exit code is 0 on success and 1 on failure.
Data (packages, Samsung certificates) is shared with the desktop app; override with NUVIO_INSTALLER_DATA_DIR.`;

function fail(message) {
  process.stderr.write(`Error: ${message}\n\n${usage}\n`);
  process.exit(1);
}

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ip: { type: "string" },
      release: { type: "string" },
      file: { type: "string" },
      "device-name": { type: "string" },
      passphrase: { type: "string" },
      "cert-profile": { type: "string" },
      "author-cert": { type: "string" },
      "distributor-cert": { type: "string" },
      "cert-password": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  return { values, positionals };
}

function createLogger(json) {
  return {
    sender: {
      send(_channel, payload) {
        const line = json ? JSON.stringify(payload) : `[${payload.type || "info"}] ${payload.text ?? ""}`;
        (payload.type === "error" ? process.stderr : process.stdout).write(`${line}\n`);
      }
    }
  };
}

async function resolveReleaseId(installer, platform, release) {
  if (!release || /^\d+$/.test(release)) return release || "";
  const releases = await installer.getRecentReleases(platform, 20);
  const bare = (tag) => String(tag).replace(/^v/i, "");
  const match = releases.find((entry) => bare(entry.tagName) === bare(release));
  if (!match) throw new Error(`Release ${release} not found among the latest ${platform} releases.`);
  return String(match.id);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    fail(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }

  const [platform, action] = positionals;
  if (!["samsung", "lg"].includes(platform)) fail(`Unknown platform "${platform}".`);
  if (!["install", "launch", "uninstall", "releases"].includes(action)) fail(`Unknown action "${action}".`);

  const installer = require("./main.js");

  if (action === "releases") {
    for (const release of await installer.getRecentReleases(platform, 20)) {
      process.stdout.write(values.json ? `${JSON.stringify(release)}\n` : `${release.tagName}\t${release.publishedAt}${release.prerelease ? "\tprerelease" : ""}\n`);
    }
    return 0;
  }

  if (!values.ip) fail("--ip is required.");

  const certPassword = values["cert-password"] || process.env.NUVIO_CERT_PASSWORD || "";
  const manualCert = Boolean(values["cert-profile"] || values["author-cert"] || values["distributor-cert"]);
  const options = {
    ip: values.ip,
    mode: values.file ? "advanced" : "simple",
    deviceName: values["device-name"] || "",
    lgPassphrase: values.passphrase || "",
    packagePath: values.file ? path.resolve(values.file) : "",
    releaseId: await resolveReleaseId(installer, platform, values.release),
    samsungCert: {
      auto: !manualCert,
      authorPath: values["author-cert"] ? path.resolve(values["author-cert"]) : "",
      distributorPath: values["distributor-cert"] ? path.resolve(values["distributor-cert"]) : "",
      password: certPassword,
      profileName: values["cert-profile"] || ""
    }
  };

  const event = createLogger(values.json);
  const send = (type, text) => event.sender.send("installer:log", { type, text });
  send("info", `Starting ${action} on ${platform}.`);
  await installer.migrateLegacySamsungCertificateStore();
  if (platform === "samsung") {
    await installer.runSamsung(event, action, options);
  } else {
    await installer.runLg(event, action, options);
  }
  send("success", "Operation completed.");
  return 0;
}

module.exports = { parse, resolveReleaseId };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[error] ${error.message || String(error)}\n`);
      process.exit(1);
    });
}
