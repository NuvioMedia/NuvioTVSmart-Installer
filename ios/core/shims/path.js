module.exports = { join: (...p) => p.join("/").replace(/\/+/g, "/"), basename: (p) => String(p).split("/").pop() };
