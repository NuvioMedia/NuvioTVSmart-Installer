const forge = require("node-forge");

// A Samsung author bundle must contain a certificate that verifies against the
// CA certificate shipped with it. A stale CA cache produces a bundle where the
// leaf is issued by the new Samsung VD Author CA but carries the old CA.
function hasValidSamsungAuthorChain(authorCertificate, password) {
  try {
    const der = forge.util.createBuffer(authorCertificate.toString("binary"));
    const pkcs12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, password);
    const certBags = pkcs12.getBags({ bagType: forge.pki.oids.certBag });
    const certificates = Object.values(certBags).flat().map((bag) => bag.cert).filter(Boolean);
    return certificates.some((issuer) => certificates.some((certificate) => {
      if (certificate === issuer) {
        return false;
      }
      try {
        return certificate.verify(issuer);
      } catch {
        return false;
      }
    }));
  } catch {
    return false;
  }
}

module.exports = { hasValidSamsungAuthorChain };
