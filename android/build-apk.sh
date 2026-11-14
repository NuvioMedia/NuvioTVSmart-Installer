#!/bin/sh
# Builds the Android installer APK.
# Usage: android/build-apk.sh <version> <output.apk>
# Needs JDK 17, the Android SDK (ANDROID_HOME) and `npm ci` already run in the repository root.
# Release signing key: NUVIO_ANDROID_KEYSTORE (path), NUVIO_ANDROID_KEYSTORE_PASSWORD,
# NUVIO_ANDROID_KEY_ALIAS, NUVIO_ANDROID_KEY_PASSWORD. Without them the build stops, unless
# NUVIO_ANDROID_DEBUG_SIGNING=1 is set for a local test build.
set -eu
cd "$(dirname "$0")"
VERSION="${1:?version required, e.g. 1.4.1}"
OUTPUT="${2:?output .apk path required}"
case "$OUTPUT" in /*) ;; *) OUTPUT="$PWD/../$OUTPUT" ;; esac

if [ -z "${NUVIO_ANDROID_KEYSTORE:-}" ] && [ "${NUVIO_ANDROID_DEBUG_SIGNING:-}" != "1" ]; then
  echo "NUVIO_ANDROID_KEYSTORE is required to sign the release APK (set NUVIO_ANDROID_DEBUG_SIGNING=1 for a local test build)." >&2
  exit 1
fi

./sync-web.sh
./gradlew --no-daemon --quiet assembleRelease -PversionName="$VERSION"

APK=app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "Expected Android APK was not created" >&2; exit 1; }
mkdir -p "$(dirname "$OUTPUT")"
cp "$APK" "$OUTPUT"
echo "Built $OUTPUT"
