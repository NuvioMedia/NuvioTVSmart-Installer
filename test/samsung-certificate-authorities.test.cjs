const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// main.js resolves ~/share/.samsung-cert from the home directory when it loads.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nuvio-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { downloadFile, getBundledSamsungCertificateAuthorities, ensureSamsungCertificateAuthorities } = require("../src/main.js");

const event = { sender: { send() {} } };
const authorityDirectory = path.join(home, "share", ".samsung-cert");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("bundles every certificate authority needed for signing", () => {
  const authorities = getBundledSamsungCertificateAuthorities();
  assert.deepEqual(
    [...authorities.keys()].sort(),
    ["vd_tizen_dev_author_ca.cer", "vd_tizen_dev_partner2.crt", "vd_tizen_dev_public2.crt"]
  );
  for (const content of authorities.values()) {
    assert.match(content.toString("utf8"), /-----BEGIN CERTIFICATE-----/);
    assert.match(content.toString("utf8"), /-----END CERTIFICATE-----/);
  }
});

test("falls back to the bundled authorities when the Samsung extension cannot be downloaded", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network unreachable");
  };
  try {
    const logs = [];
    await ensureSamsungCertificateAuthorities({ sender: { send: (_channel, payload) => logs.push(payload) } });
    assert.deepEqual(
      fs.readdirSync(authorityDirectory).filter((name) => /\.(crt|cer)$/i.test(name)).sort(),
      ["vd_tizen_dev_author_ca.cer", "vd_tizen_dev_partner2.crt", "vd_tizen_dev_public2.crt"]
    );
    assert.match(fs.readFileSync(path.join(authorityDirectory, "vd_tizen_dev_author_ca.cer"), "utf8"), /BEGIN CERTIFICATE/);
    assert.equal(fs.readFileSync(path.join(authorityDirectory, ".extension"), "utf8"), "");
    assert.ok(logs.some((entry) => entry.type === "warning" && /bundled with the installer/.test(entry.text)));
  } finally {
    global.fetch = realFetch;
  }
});

test("replaces a truncated cached authority instead of trusting it", async () => {
  fs.writeFileSync(path.join(authorityDirectory, "vd_tizen_dev_public2.crt"), "-----BEGIN CERTIFICATE-----");
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network unreachable");
  };
  try {
    await ensureSamsungCertificateAuthorities(event);
    assert.match(fs.readFileSync(path.join(authorityDirectory, "vd_tizen_dev_public2.crt"), "utf8"), /END CERTIFICATE/);
  } finally {
    global.fetch = realFetch;
  }
});

test("installs the bundled authorities when the Samsung archive arrives damaged", async () => {
  const realFetch = global.fetch;
  const repository = "https://download.tizen.org/sdk/extensions/damaged.zip";
  const damagedArchive = Buffer.alloc(4096, 0x41);
  let archiveRequests = 0;
  global.fetch = async (url) => {
    if (String(url).includes("extension_info.xml")) {
      return new Response(
        `<extensionSDK><extension><name>Samsung Certificate Extension</name><repository>${repository}</repository></extension></extensionSDK>`,
        { status: 200 }
      );
    }
    archiveRequests += 1;
    return new Response(damagedArchive, { status: 200, headers: { "content-length": String(damagedArchive.length) } });
  };
  try {
    const logs = [];
    await ensureSamsungCertificateAuthorities({ sender: { send: (_channel, payload) => logs.push(payload) } });
    assert.equal(archiveRequests, 1);
    const bundled = getBundledSamsungCertificateAuthorities();
    for (const [fileName, content] of bundled) {
      assert.deepEqual(fs.readFileSync(path.join(authorityDirectory, fileName)), content);
    }
    assert.equal(fs.readFileSync(path.join(authorityDirectory, ".extension"), "utf8"), repository);
    assert.ok(logs.some((entry) => entry.type === "warning" && /bundled with the installer/.test(entry.text)));
  } finally {
    global.fetch = realFetch;
  }
});

test("rejects a download shorter than the advertised content length", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Length": "4096" });
    response.write("truncated");
    response.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const targetPath = path.join(os.tmpdir(), `nuvio-truncated-${Date.now()}.zip`);
  try {
    await assert.rejects(
      downloadFile(event, `http://127.0.0.1:${server.address().port}/archive.zip`, targetPath),
      /incomplete|terminated|aborted|fetch failed|closed/i
    );
    assert.equal(fs.existsSync(targetPath), false);
  } finally {
    await fsp.rm(targetPath, { force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
