const Module = require("node:module");
const util = require("node:util");
require("./webos-key-download-diagnostics");

const originalLoad = Module._load;

if (typeof util.isDate !== "function") {
  util.isDate = function isDate(value) {
    return value instanceof Date;
  };
}

function preferEcdhKex(algorithms) {
  if (!algorithms || !Array.isArray(algorithms.kex)) {
    return algorithms;
  }

  const priority = [
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1",
    "diffie-hellman-group-exchange-sha256",
    "diffie-hellman-group-exchange-sha1"
  ];
  const original = algorithms.kex;
  const reordered = [
    ...priority.filter((name) => original.includes(name)),
    ...original.filter((name) => !priority.includes(name))
  ];

  return {
    ...algorithms,
    kex: reordered
  };
}

function patchSsh2(ssh2) {
  if (!ssh2 || !ssh2.Client || ssh2.Client.__nuvioWebosCompatPatched) {
    return ssh2;
  }

  const OriginalClient = ssh2.Client;

  class NuvioWebosCompatClient extends OriginalClient {
    connect(config) {
      if (config && config.algorithms) {
        config = {
          ...config,
          algorithms: preferEcdhKex(config.algorithms)
        };
      }

      return super.connect(config);
    }
  }

  NuvioWebosCompatClient.__nuvioWebosCompatPatched = true;
  ssh2.Client = NuvioWebosCompatClient;
  return ssh2;
}

Module._load = function patchedLoad(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  return request === "ssh2" ? patchSsh2(loaded) : loaded;
};
