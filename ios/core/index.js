// Same signing, certificate and WGT validation code as the desktop installer (src/main.js),
// running inside the iOS WebView. Package bytes stay native; only metadata crosses the bridge.
import { Buffer } from "buffer";
globalThis.Buffer = globalThis.Buffer || Buffer;
const forge = require("node-forge");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const Signature = require("tizen/src/packageSigner.js");
const SamsungCertificateCreator = require("tizen/src/samsungCertificateCreator.js");
const { hasValidSamsungAuthorChain } = require("../../src/samsung-certificate-chain.js");
const config = require("../../installer.config.json");

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

// JSZip-like view over { name: { dir, text } } sent by the host.
function zipView(entries) {
  const files = {};
  for (const [name, entry] of Object.entries(entries)) {
    files[name] = { dir: Boolean(entry.dir), async: async () => entry.text ?? "" };
  }
  return { files };
}

function elementsByTagName(doc, tagName, namespaceUri, localName) {
  const elements = Array.from(doc.getElementsByTagName(tagName));
  try {
    elements.push(...Array.from(doc.getElementsByTagNameNS(namespaceUri, localName)));
  } catch {}
  return Array.from(new Set(elements));
}

function isValidSamsungPackageId(packageId) {
  return /^[A-Za-z0-9]{10}$/.test(String(packageId || ""));
}

async function parseTizenPackageMetadata(zip) {
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
      version: doc.documentElement.getAttribute("version") || "",
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
      version: manifest?.getAttribute("version") || "",
      requiredVersion: "",
      extension: "tpk"
    };
  }

  throw new Error("Invalid Tizen package: config.xml or tizen-manifest.xml is missing.");
}

async function validateSamsungEngineFsWebServicePackage(zip, logs) {
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

  logs.push({ type: "info", text: "Samsung WGT includes the local Tizen P2P Web Service." });
}

async function validateSamsungPluginWebServicePackage(zip, logs) {
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

  logs.push({
    type: "info",
    text: "Samsung WGT includes the canonical local Tizen Plugin Web Service contract (external helper and inline wrt:service bridge)."
  });
}

// Returns the rewritten config.xml when the package id must be normalized, otherwise null.
async function normalizeSamsungPackageMetadata(zip, logs) {
  const targetPackageId = String(config.tizen.packageId || "").trim();
  const targetAppId = String(config.tizen.appId || "").trim();

  if (!isValidSamsungPackageId(targetPackageId) || !targetAppId.startsWith(`${targetPackageId}.`)) {
    return null;
  }
  const configFile = zip.files["config.xml"];
  if (!configFile) {
    return null;
  }

  const xml = await configFile.async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const application = doc.getElementsByTagName("tizen:application")[0]
    || doc.getElementsByTagNameNS("http://tizen.org/ns/widgets", "application")[0];
  if (!application) {
    return null;
  }

  const currentPackageId = application.getAttribute("package") || "";
  const currentAppId = application.getAttribute("id") || "";
  if (isValidSamsungPackageId(currentPackageId) && currentAppId.startsWith(`${currentPackageId}.`)) {
    return null;
  }

  application.setAttribute("package", targetPackageId);
  application.setAttribute("id", targetAppId);
  logs.push({ type: "info", text: `Normalized Samsung package id: ${currentPackageId || "(empty)"} -> ${targetPackageId}` });
  return new XMLSerializer().serializeToString(doc);
}

function pkcs12From(base64, password) {
  const der = forge.util.createBuffer(Buffer.from(base64, "base64").toString("binary"));
  return forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, password);
}

globalThis.__nuvioCore = {
  config,

  async inspect(entries) {
    const zip = zipView(entries);
    const logs = [];
    const normalizedConfig = await normalizeSamsungPackageMetadata(zip, logs);
    if (normalizedConfig !== null) {
      zip.files["config.xml"] = { dir: false, async: async () => normalizedConfig };
    }
    const metadata = await parseTizenPackageMetadata(zip);
    return { normalizedConfig, metadata, logs };
  },

  async metadata(entries) {
    return parseTizenPackageMetadata(zipView(entries));
  },

  async validate(entries) {
    const zip = zipView(entries);
    const logs = [];
    await validateSamsungEngineFsWebServicePackage(zip, logs);
    await validateSamsungPluginWebServicePackage(zip, logs);
    return logs;
  },

  hasValidSamsungAuthorChain(authorCertBase64, password) {
    return hasValidSamsungAuthorChain(Buffer.from(String(authorCertBase64 || ""), "base64"), password);
  },

  // files: [{ name, digest }] in archive order; returns [{ name, xml? }] in output order.
  async sign(files, authorCertBase64, distributorCertBase64, password) {
    const unsignedFiles = files.map((file) => ({
      uri: encodeURIComponent(file.name),
      data: { __digest: file.digest, __name: file.name }
    }));
    const authorKey = pkcs12From(authorCertBase64, password);
    const distributorKey = pkcs12From(distributorCertBase64, password);

    const authorSignature = new Signature("AuthorSignature", unsignedFiles);
    const authorFiles = await authorSignature.sign(authorKey);
    const distributorSignature = new Signature("DistributorSignature", authorFiles);
    const distributorFiles = await distributorSignature.sign(distributorKey);

    return distributorFiles.map((file) => {
      const name = decodeURIComponent(file.uri);
      return Buffer.isBuffer(file.data) ? { name, xml: file.data.toString("utf8") } : { name };
    });
  },

  // Key pairs and CSRs, exactly as tizen SamsungCertificateCreator builds them.
  createRequests(authorInfo, duidList) {
    const creator = new SamsungCertificateCreator();
    return {
      author: creator._generateAuthorCert(authorInfo),
      distributor: creator._generateDistributorCert(authorInfo, duidList)
    };
  },

  // caFiles: { fileName: text } from ~/share/.samsung-cert equivalent.
  buildPkcs12(requests, authorCertVD, distributorCertVD, authorInfo, caFiles) {
    globalThis.__nuvioFiles = caFiles;
    const creator = new SamsungCertificateCreator();
    const author = creator._generateAuthorPKCS12(requests.author, authorCertVD, authorInfo);
    const distributor = creator._generateDistributorPKCS12(requests.distributor, distributorCertVD, authorInfo);
    return {
      authorCert: Buffer.from(author, "binary").toString("base64"),
      distributorCert: Buffer.from(distributor, "binary").toString("base64")
    };
  }
};
