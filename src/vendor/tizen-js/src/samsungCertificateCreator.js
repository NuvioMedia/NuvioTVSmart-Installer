const forge = require("node-forge");
const fetch = require("node-fetch");
const { join, basename } = require("node:path");
const JSZip = require("jszip");
const FormData = require("form-data");
const { readFileSync, mkdirSync, writeFileSync, existsSync } = require("node:fs");
const { DOMParser } = require("@xmldom/xmldom");
const { homedir } = require("node:os");

const samsungCertDir = join(homedir(), "share/.samsung-cert");
const distributorEndpoints = {
  profileV1: "https://svdca.samsungqbe.com/apis/v1/distributors",
  certificateV3: "https://svdca.samsungqbe.com/apis/v3/distributors"
};

function formatPemCertificate(body) {
  const normalized = String(body || "")
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/[\r\n\s]+/g, "");

  return `-----BEGIN CERTIFICATE-----\n${normalized.replace(/(.{64})/g, "$1\n").trim()}\n-----END CERTIFICATE-----\n`;
}

function isPemCertificate(text) {
  return /-----BEGIN CERTIFICATE-----/.test(String(text || ""));
}

function getProfileCertificatePem(profileXml) {
  const match = String(profileXml || "").match(/<Certificate>([\s\S]*?)<\/Certificate>/i);
  if (!match) {
    return "";
  }
  return formatPemCertificate(match[1]);
}

function isDeviceProfileXml(text) {
  try {
    const doc = new DOMParser().parseFromString(String(text || ""), "text/xml");
    const root = doc.documentElement;
    return root?.localName === "Profile" && root.getElementsByTagName("Certificate").length > 0;
  } catch {
    return false;
  }
}

class SamsungCertificateCreator {
  async _downloadVDCertificates() {
    if (existsSync(samsungCertDir)) {
      return;
    }

    let buffer;
    try {
      const extensionInfoReq = await fetch("https://download.tizen.org/sdk/tizenstudio/official/extension_info.xml");
      const extensionInfo = await extensionInfoReq.text();
      const parser = new DOMParser().parseFromString(extensionInfo, "text/xml").firstChild;

      const extensions = parser.getElementsByTagName("extension");
      for (const extension of Array.from(extensions)) {
        const name = extension.getElementsByTagName("name")[0].textContent.trim();
        if (name === "Samsung Certificate Extension") {
          const repository = extension.getElementsByTagName("repository")[0].textContent.trim();
          const response = await fetch(repository);
          if (!response.ok) {
            throw new Error(`Failed to download Samsung Certificate Extension: ${response.statusText}`);
          }
          buffer = await response.buffer();
          break;
        }
      }
    } catch (error) {
      console.error("Error downloading Samsung Certificate Extension:", error, "Will try downloading manually");
    }

    if (!buffer) {
      const response = await fetch("https://download.tizen.org/sdk/extensions/tizen-certificate-extension_2.0.70.zip");
      if (!response.ok) {
        throw new Error(`Failed to download Samsung Certificate Extension: ${response.statusText}`);
      }
      buffer = await response.buffer();
    }

    const zip = await JSZip.loadAsync(buffer);
    const addonFileName = Object.keys(zip.files).find((name) => name.endsWith(".zip"));
    const addonFileBuffer = await zip.files[addonFileName].async("nodebuffer");
    const addonFileZip = await JSZip.loadAsync(addonFileBuffer);
    const jarFileName = Object.keys(addonFileZip.files).find((name) => name.endsWith(".jar"));
    const jarFileBuffer = await addonFileZip.files[jarFileName].async("nodebuffer");
    const jarZip = await JSZip.loadAsync(jarFileBuffer);

    mkdirSync(samsungCertDir, { recursive: true });
    for (const fileName of Object.keys(jarZip.files)) {
      if (fileName.endsWith(".crt") || fileName.endsWith(".cer")) {
        const filePath = join(samsungCertDir, basename(fileName));
        const content = await jarZip.files[fileName].async("nodebuffer");
        writeFileSync(filePath, content);
      }
    }
  }

  _generateAuthorCert(authorInfo) {
    const key = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = key.publicKey;
    csr.setSubject([
      { name: "countryName", value: "" },
      { name: "stateOrProvinceName", value: "" },
      { name: "localityName", value: "" },
      { name: "organizationName", value: "" },
      { name: "organizationalUnitName", value: "" },
      { name: "commonName", value: authorInfo.name }
    ]);

    const privateKey = forge.pki.privateKeyToPem(key.privateKey);
    csr.sign(key.privateKey, forge.md.sha512.create());

    return {
      csr: forge.pki.certificationRequestToPem(csr),
      privateKey
    };
  }

  _generateDistributorCert(authorInfo, duidList) {
    const key = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = key.publicKey;
    csr.setSubject([
      { name: "commonName", value: "TizenSDK" },
      { name: "organizationalUnitName", value: "" },
      { name: "organizationName", value: "" },
      { name: "localityName", value: "" },
      { name: "stateOrProvinceName", value: "" },
      { name: "countryName", value: "" },
      { name: "emailAddress", value: authorInfo.email }
    ]);

    const subjectAltNames = [
      {
        type: 6,
        value: "URN:tizen:packageid="
      }
    ];

    for (const duid of duidList) {
      subjectAltNames.push({
        type: 6,
        value: `URN:tizen:deviceid=${duid}`
      });
    }

    csr.setAttributes([
      {
        name: "extensionRequest",
        extensions: [
          {
            name: "subjectAltName",
            altNames: subjectAltNames
          }
        ]
      }
    ]);

    const privateKey = forge.pki.privateKeyToPem(key.privateKey);
    csr.sign(key.privateKey, forge.md.sha512.create());

    return {
      csr: forge.pki.certificationRequestToPem(csr),
      privateKey
    };
  }

  async _fetchAuthorCert(accessInfo, authorCert) {
    const formData = new FormData();
    formData.append("access_token", accessInfo.accessToken);
    formData.append("user_id", accessInfo.userId);
    formData.append("platform", "VD");
    formData.append("csr", authorCert.csr, {
      contentType: "application/octet-stream",
      filename: "author.csr"
    });

    const request = await fetch("https://svdca.samsungqbe.com/apis/v3/authors", {
      method: "POST",
      headers: formData.getHeaders(),
      body: formData
    });

    const text = await request.text();
    if (!request.ok) {
      throw new Error(`Failed to fetch author certificate\n${text}`);
    }
    return text;
  }

  async _fetchDistributor(accessInfo, authorInfo, distributorCert, endpoint, includePlatform) {
    const formData = new FormData();
    formData.append("access_token", accessInfo.accessToken);
    formData.append("user_id", accessInfo.userId);
    if (includePlatform) {
      formData.append("platform", "VD");
    }
    formData.append("privilege_level", authorInfo.privilegeLevel);
    formData.append("developer_type", "Individual");
    formData.append("csr", distributorCert.csr, {
      contentType: "application/octet-stream",
      filename: "distributor.csr"
    });

    const request = await fetch(endpoint, {
      method: "POST",
      headers: formData.getHeaders(),
      body: formData
    });

    const text = await request.text();
    if (!request.ok) {
      throw new Error(`Failed to fetch distributor certificate\n${text}`);
    }
    return text;
  }

  async _fetchDistributorMaterials(accessInfo, authorInfo, distributorCert) {
    const attempts = [
      {
        endpoint: distributorEndpoints.profileV1,
        includePlatform: false,
        profileExpected: true,
        label: "legacy Samsung device-profile endpoint"
      },
      {
        endpoint: distributorEndpoints.profileV1,
        includePlatform: true,
        profileExpected: true,
        label: "legacy Samsung device-profile endpoint with VD platform"
      },
      {
        endpoint: distributorEndpoints.certificateV3,
        includePlatform: true,
        profileExpected: false,
        label: "Samsung VD certificate endpoint"
      }
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const responseText = await this._fetchDistributor(
          accessInfo,
          authorInfo,
          distributorCert,
          attempt.endpoint,
          attempt.includePlatform
        );

        if (isDeviceProfileXml(responseText)) {
          return {
            distributorCertPem: getProfileCertificatePem(responseText),
            distributorXML: responseText,
            source: attempt.label
          };
        }

        if (attempt.profileExpected) {
          lastError = new Error(`${attempt.label} did not return a Samsung device profile.`);
          continue;
        }

        if (isPemCertificate(responseText)) {
          return {
            distributorCertPem: responseText,
            distributorXML: "",
            source: attempt.label
          };
        }

        lastError = new Error(`${attempt.label} returned an unknown response format.`);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Failed to fetch a Samsung distributor certificate.");
  }

  _generateAuthorPKCS12(authorCert, authorCertPem, authorInfo) {
    const vdTizenAuthorCer = readFileSync(join(samsungCertDir, "vd_tizen_dev_author_ca.cer"), "utf-8");
    const privateKey = forge.pki.privateKeyFromPem(authorCert.privateKey);
    const authorCertArray = [authorCertPem, vdTizenAuthorCer];
    const pkcs12Cert = forge.pkcs12.toPkcs12Asn1(privateKey, authorCertArray, authorInfo.password, {
      generateLocalKeyId: true,
      friendlyName: "UserCertificate"
    });

    return forge.asn1.toDer(pkcs12Cert).getBytes();
  }

  _selectDistributorCa(authorInfo, distributorCertPem) {
    const cert = forge.pki.certificateFromPem(distributorCertPem);
    const issuerCn = cert.issuer.getField("CN")?.value || "";
    const caPrefix = issuerCn.includes("VD DEVELOPER") ? "vd_tizen_dev" : "samsung_tizen_dev";
    const level = String(authorInfo.privilegeLevel || "Public").toLowerCase();
    const safeLevel = ["public", "partner", "platform"].includes(level) ? level : "public";
    return readFileSync(join(samsungCertDir, `${caPrefix}_${safeLevel}2.crt`), "utf-8");
  }

  _generateDistributorPKCS12(distributorCert, distributorCertPem, authorInfo) {
    const distributorCaPem = this._selectDistributorCa(authorInfo, distributorCertPem);
    const privateKey = forge.pki.privateKeyFromPem(distributorCert.privateKey);
    const distributorCertArray = [distributorCertPem, distributorCaPem];
    const pkcs12Cert = forge.pkcs12.toPkcs12Asn1(privateKey, distributorCertArray, authorInfo.password, {
      generateLocalKeyId: true,
      friendlyName: "UserCertificate"
    });

    return forge.asn1.toDer(pkcs12Cert).getBytes();
  }

  async createCertificate(authorInfo, accessInfo, duidList) {
    await this._downloadVDCertificates();

    const authorCert = this._generateAuthorCert(authorInfo);
    const distributorCert = this._generateDistributorCert(authorInfo, duidList);
    const authorCertPem = await this._fetchAuthorCert(accessInfo, authorCert);
    const distributorMaterials = await this._fetchDistributorMaterials(accessInfo, authorInfo, distributorCert);
    const vdAuthorCert = this._generateAuthorPKCS12(authorCert, authorCertPem, authorInfo);
    const distributorPkcs12 = this._generateDistributorPKCS12(
      distributorCert,
      distributorMaterials.distributorCertPem,
      authorInfo
    );

    return {
      authorCert: vdAuthorCert,
      distributorCert: distributorPkcs12,
      distributorXML: distributorMaterials.distributorXML,
      distributorSource: distributorMaterials.source
    };
  }
}

module.exports = SamsungCertificateCreator;
