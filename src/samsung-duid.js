// The TV answers getduid with its DUID, but a slow or older set can print a diagnostic line first
// (for example "Failed open device" on Tizen 9). Only a bare device id is a valid DUID.
const SAMSUNG_DUID_PATTERN = /^[A-Za-z0-9]{10,64}$/;

function parseSamsungDuid(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => SAMSUNG_DUID_PATTERN.test(line)) || "";
}

module.exports = { parseSamsungDuid };
