export const process = { env: {}, versions: {}, platform: "browser", nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)) };
