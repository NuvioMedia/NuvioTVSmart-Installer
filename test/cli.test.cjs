const assert = require("node:assert/strict");
const test = require("node:test");
const { parse, resolveReleaseId } = require("../src/cli.js");

test("parses platform, action and options", () => {
  const { values, positionals } = parse(["samsung", "install", "--ip", "192.168.0.15", "--release", "1.4.1", "--json"]);
  assert.deepEqual(positionals, ["samsung", "install"]);
  assert.equal(values.ip, "192.168.0.15");
  assert.equal(values.release, "1.4.1");
  assert.equal(values.json, true);
});

test("rejects unknown options", () => {
  assert.throws(() => parse(["lg", "install", "--nope"]));
});

test("resolves a release tag to its id and keeps numeric ids", async () => {
  const installer = { getRecentReleases: async () => [{ id: 7, tagName: "1.4.1" }] };
  assert.equal(await resolveReleaseId(installer, "tizen", "1.4.1"), "7");
  assert.equal(await resolveReleaseId(installer, "tizen", "v1.4.1"), "7");
  assert.equal(await resolveReleaseId(installer, "tizen", "42"), "42");
  assert.equal(await resolveReleaseId(installer, "tizen", ""), "");
  await assert.rejects(resolveReleaseId(installer, "tizen", "9.9.9"));
});

test("reads the installed Nuvio version from ares-install --listfull", () => {
  const { parseAresListFullVersion } = require("../src/main.js");
  const output = "id : com.other.app\nversion : 9.9.9\ntype : web\nid : space.nuvio.webos\nversion : 1.4.0\ntype : web";
  assert.equal(parseAresListFullVersion(output, "space.nuvio.webos"), "1.4.0");
  assert.equal(parseAresListFullVersion(output, "missing.app"), "");
});
