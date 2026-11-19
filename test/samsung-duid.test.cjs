const assert = require("node:assert/strict");
const test = require("node:test");
const { parseSamsungDuid } = require("../src/samsung-duid");

test("reads the DUID printed on its own", () => {
  assert.equal(parseSamsungDuid("JHCKEHBTKL5JI\n"), "JHCKEHBTKL5JI");
  assert.equal(parseSamsungDuid("ABC123DEF456GHI7890JKL"), "ABC123DEF456GHI7890JKL");
});

test("ignores a diagnostic line before the DUID", () => {
  assert.equal(parseSamsungDuid("Failed open device: Operation not permitted\r\n43CEUO2QLDUT2\r\n"), "43CEUO2QLDUT2");
});

test("ignores a diagnostic line after the DUID", () => {
  assert.equal(parseSamsungDuid("43CEUO2QLDUT2\nFailed open device: Operation not permitted\n"), "43CEUO2QLDUT2");
});

test("does not treat a failed command as a DUID", () => {
  assert.equal(parseSamsungDuid("Failed open device: Operation not permitted\n"), "");
  assert.equal(parseSamsungDuid("closed\n"), "");
  assert.equal(parseSamsungDuid(""), "");
});
