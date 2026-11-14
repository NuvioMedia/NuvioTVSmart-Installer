#!/bin/sh
# Copies the desktop installer UI verbatim (same HTML/CSS/JS/logos/config), the app icon,
# and bundles the desktop signing/certificate code for the iOS WebView.
set -e
cd "$(dirname "$0")"
ROOT=..
rm -rf web/app && mkdir -p web/app/src/renderer web/app/logo
cp "$ROOT"/src/renderer/index.html "$ROOT"/src/renderer/styles.css "$ROOT"/src/renderer/renderer.js web/app/src/renderer/
cp "$ROOT"/logo/* web/app/logo/
cp "$ROOT"/installer.config.json web/
sips -s format png -z 1024 1024 "$ROOT"/build/icon.png --out Sources/Assets.xcassets/AppIcon.appiconset/icon.png >/dev/null
[ -x core/node_modules/.bin/esbuild ] || (cd core && npm ci --no-audit --no-fund)
core/build.sh
