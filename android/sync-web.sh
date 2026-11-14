#!/bin/sh
# Copies the desktop installer UI verbatim (same HTML/CSS/JS/logos/config), the shared phone
# layout (ios/web/ios.css) and the bundled desktop signing/certificate code into the APK assets.
set -e
cd "$(dirname "$0")"
ROOT=..
WEB=app/src/main/assets/web
rm -rf "$WEB/app" && mkdir -p "$WEB/app/src/renderer" "$WEB/app/logo"
cp "$ROOT"/src/renderer/index.html "$ROOT"/src/renderer/styles.css "$ROOT"/src/renderer/renderer.js "$WEB/app/src/renderer/"
cp "$ROOT"/logo/* "$WEB/app/logo/"
cp "$ROOT"/installer.config.json "$WEB/"
cp "$ROOT"/ios/web/ios.css "$WEB/mobile.css"
[ -x "$ROOT"/ios/core/node_modules/.bin/esbuild ] || (cd "$ROOT"/ios/core && npm ci --no-audit --no-fund)
"$ROOT"/ios/core/build.sh
cp "$ROOT"/ios/web/nuvio-core.js "$WEB/nuvio-core.js"
