#!/bin/sh
# Builds the unsigned iOS installer IPA (sideload with AltStore/SideStore/Sideloadly).
# Usage: ios/build-ipa.sh <version> <output.ipa>
# Needs macOS with Xcode, xcodegen, and `npm ci` already run in the repository root.
set -eu
cd "$(dirname "$0")"
VERSION="${1:?version required, e.g. 1.4.1}"
OUTPUT="${2:?output .ipa path required}"
case "$OUTPUT" in /*) ;; *) OUTPUT="$PWD/../$OUTPUT" ;; esac

./sync-web.sh
xcodegen generate --quiet
mkdir -p NuvioTVInstaller.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
cp Package.resolved NuvioTVInstaller.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved

rm -rf build/Build/Products/Release-iphoneos
xcodebuild -project NuvioTVInstaller.xcodeproj -scheme NuvioTVInstaller \
  -destination 'generic/platform=iOS' -configuration Release -derivedDataPath build \
  -disableAutomaticPackageResolution \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$VERSION" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build -quiet

APP="build/Build/Products/Release-iphoneos/Nuvio TV Installer.app"
[ -d "$APP" ] || { echo "Expected iOS app was not created" >&2; exit 1; }
PLIST_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")"
[ "$PLIST_VERSION" = "$VERSION" ] || { echo "Unexpected app version $PLIST_VERSION (expected $VERSION)" >&2; exit 1; }

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"
(cd "$STAGE" && zip -qry "$OUTPUT" Payload)
rm -rf "$STAGE"
echo "Built $OUTPUT"
