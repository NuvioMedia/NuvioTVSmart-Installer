#!/usr/bin/env node
// Writes the AltStore/SideStore source for the iOS installer.
// Usage: node ios/altstore-source.mjs --ipa <file.ipa> --version <1.4.1> --tag <release tag> --download-url <url> --out <source.json>
import { readFileSync, statSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
for (const key of ["ipa", "version", "download-url", "out"]) {
  if (!args[key]) throw new Error(`--${key} is required`);
}

const config = JSON.parse(readFileSync(new URL("../installer.config.json", import.meta.url), "utf8"));
const repo = config.githubRepo;
const iconURL = "https://raw.githubusercontent.com/NuvioMedia/NuvioTVSmart-Installer/main/build/icon.png";
const description = "Install, update, launch and remove Nuvio TV on Samsung Tizen and LG webOS TVs from your iPhone or iPad, "
  + "on the same network as the TV. Same features as the Windows, macOS and Linux Nuvio TV Installer.";

const source = {
  name: "Nuvio TV Installer",
  subtitle: "Install Nuvio TV on Samsung and LG TVs",
  description,
  iconURL,
  website: `https://github.com/${repo}`,
  tintColor: "#0D0D0D",
  apps: [{
    name: "Nuvio TV Installer",
    bundleIdentifier: "space.nuvio.webtvinstaller",
    developerName: "NuvioMedia",
    subtitle: "Install Nuvio TV on Samsung and LG TVs",
    localizedDescription: description,
    iconURL,
    tintColor: "#0D0D0D",
    category: "utilities",
    versions: [{
      version: args.version,
      buildVersion: args.version,
      date: new Date().toISOString(),
      localizedDescription: `Nuvio TV ${args.version}. Release notes: https://github.com/${repo}/releases/tag/${args.tag || args.version}`,
      downloadURL: args["download-url"],
      size: statSync(args.ipa).size,
      minOSVersion: "17.0"
    }],
    appPermissions: {
      entitlements: [],
      privacy: {
        NSLocalNetworkUsageDescription: "Nuvio TV Installer connects to your TV on the local network to install and manage Nuvio."
      }
    }
  }],
  news: []
};

writeFileSync(args.out, JSON.stringify(source, null, 2) + "\n");
console.log(`Wrote ${args.out}`);
