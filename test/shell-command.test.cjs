const assert = require("node:assert/strict");
const test = require("node:test");
const { quoteShellArgument } = require("../src/shell-command");

test("leaves arguments without shell metacharacters untouched", () => {
  assert.equal(quoteShellArgument("install"), "install");
  assert.equal(quoteShellArgument("-n"), "-n");
  assert.equal(
    quoteShellArgument("C:\\tizen-studio\\tools\\sdb.exe"),
    "C:\\tizen-studio\\tools\\sdb.exe",
  );
  assert.equal(quoteShellArgument("192.168.1.39:26101"), "192.168.1.39:26101");
});

test("quotes a path that contains spaces", () => {
  assert.equal(
    quoteShellArgument(
      "C:\\Users\\movie fan\\AppData\\Roaming\\Nuvio TV Installer\\resigned\\app.wgt",
    ),
    '"C:\\Users\\movie fan\\AppData\\Roaming\\Nuvio TV Installer\\resigned\\app.wgt"',
  );
});

test("quotes cmd.exe separators and escaped quotes", () => {
  assert.equal(quoteShellArgument("a&b"), '"a&b"');
  assert.equal(quoteShellArgument('a"b'), '"a""b"');
});
