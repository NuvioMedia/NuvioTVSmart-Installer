// Node concatenates the arguments of a shell command without escaping them, so
// cmd.exe splits a Windows path such as "Nuvio TV Installer" into two arguments.
function quoteShellArgument(value) {
  const text = String(value);
  if (!/[\s"&|<>^()]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

module.exports = { quoteShellArgument };
