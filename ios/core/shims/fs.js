// Only readFileSync of the Samsung CA files is reached; they are injected by the host.
globalThis.__nuvioFiles = globalThis.__nuvioFiles || {};
module.exports = {
  readFileSync(p) { const k = String(p).split("/").pop(); if (!(k in globalThis.__nuvioFiles)) throw new Error("Missing " + k); return globalThis.__nuvioFiles[k]; },
  existsSync() { return true; }, mkdirSync() {}, writeFileSync() {}
};
