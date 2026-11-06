const assert = require("node:assert/strict");
const test = require("node:test");
const forge = require("node-forge");
const { hasValidSamsungAuthorChain } = require("../src/samsung-certificate-chain");

function createCertificate(subject, issuer, signingKey = null, publicKey = null) {
  const key = forge.pki.rsa.generateKeyPair(1024);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey || key.publicKey;
  certificate.serialNumber = String(Math.floor(Math.random() * 100000) + 1);
  certificate.validity.notBefore = new Date(Date.now() - 86400000);
  certificate.validity.notAfter = new Date(Date.now() + 86400000);
  certificate.setSubject([{ name: "commonName", value: subject }]);
  certificate.setIssuer([{ name: "commonName", value: issuer }]);
  certificate.sign(signingKey || key.privateKey, forge.md.sha256.create());
  return { certificate, key };
}

function createBundle(leaf, issuer) {
  return forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(leaf.key.privateKey, [leaf.certificate, issuer.certificate], "password", {
    generateLocalKeyId: true,
    friendlyName: "UserCertificate"
  })).getBytes();
}

test("accepts an author certificate signed by the bundled authority", () => {
  const authority = createCertificate("Samsung VD Author CA", "Tizen Developers Root Class");
  const author = createCertificate("Nuvio", "Samsung VD Author CA", authority.key.privateKey);
  assert.equal(hasValidSamsungAuthorChain(Buffer.from(createBundle(author, authority), "binary"), "password"), true);
});

test("rejects an author certificate that does not match the bundled authority", () => {
  const oldAuthority = createCertificate("Samsung Author CA Class", "Tizen Developers Root Class");
  const newAuthority = createCertificate("Samsung VD Author CA", "Tizen Developers Root Class");
  const author = createCertificate("Nuvio", "Samsung VD Author CA", newAuthority.key.privateKey);
  assert.equal(hasValidSamsungAuthorChain(Buffer.from(createBundle(author, oldAuthority), "binary"), "password"), false);
});

test("rejects unreadable certificate data", () => {
  assert.equal(hasValidSamsungAuthorChain(Buffer.from("not a certificate"), "password"), false);
});
