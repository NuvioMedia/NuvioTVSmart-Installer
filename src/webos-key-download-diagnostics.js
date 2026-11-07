const http = require("node:http");

// The webOS CLI replaces HTTP errors with "Failed to get ssh private key".
// Observe only the Developer Mode key endpoint; never log URLs, headers,
// response bodies, passphrases, or key contents, and preserve CLI behavior.
const observed = new WeakSet();

function isKeyDownload(args) {
  const target = args[0];
  if (typeof target === "string" || target instanceof URL) {
    try {
      const url = new URL(target);
      return url.port === "9991" && url.pathname === "/webos_rsa";
    } catch {
      return false;
    }
  }
  return target && String(target.port) === "9991" && target.path === "/webos_rsa";
}

function report(text) {
  process.stderr.write(`[webOS key download] ${text}\n`);
}

for (const method of ["request", "get"]) {
  const original = http[method];
  http[method] = function (...args) {
    const request = original.apply(this, args);
    if (!isKeyDownload(args) || observed.has(request)) return request;
    observed.add(request);
    const operation = method === "get" ? "GET" : String(args[0]?.method || "GET").toUpperCase();
    // Use fixed labels and error codes rather than error messages, which may
    // contain user-controlled data. Leave the original error object untouched.
    const label = operation === "HEAD" ? "HEAD" : "GET";
    request.on("error", (error) => {
      const code = /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : "UNKNOWN";
      report(`${label} failed (${code}).`);
    });
    request.on("response", (response) => {
      if (Number.isInteger(response.statusCode) && response.statusCode !== 200) {
        report(`${label} returned HTTP ${response.statusCode}.`);
      }
    });
    return request;
  };
}
