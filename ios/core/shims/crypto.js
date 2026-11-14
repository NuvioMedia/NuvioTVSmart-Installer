// Node crypto subset used by tizen/packageSigner.js, backed by node-forge.
// Large package files are hashed natively; they arrive as { __digest } markers.
const forge = require("node-forge");
function createHash(alg) {
  if (alg !== "sha512") throw new Error("Unsupported hash " + alg);
  let pre = null;
  const md = forge.md.sha512.create();
  return {
    update(data) {
      if (data && data.__digest) { pre = data.__digest; return this; }
      md.update(Buffer.isBuffer(data) ? data.toString("binary") : String(data), Buffer.isBuffer(data) ? "raw" : "utf8");
      return this;
    },
    digest(enc) { return pre || forge.util.encode64(md.digest().getBytes()); }
  };
}
function createSign(alg) {
  if (alg !== "RSA-SHA512") throw new Error("Unsupported sign " + alg);
  const md = forge.md.sha512.create();
  return {
    update(data) { md.update(String(data), "utf8"); return this; },
    sign(pem) { return forge.util.encode64(forge.pki.privateKeyFromPem(pem).sign(md)); }
  };
}
module.exports = { createHash, createSign };
