#!/bin/sh
# Bundles the desktop installer's signing/certificate code for the iOS WebView.
set -e
cd "$(dirname "$0")"
I=../../node_modules
./node_modules/.bin/esbuild index.js --bundle --format=iife --platform=browser --target=safari15 --outfile=../web/nuvio-core.js \
  --alias:crypto=./shims/crypto.js --alias:fs=./shims/fs.js --alias:path=./shims/path.js --alias:os=./shims/os.js \
  --alias:node-fetch=./shims/empty.js --alias:jszip=./shims/empty.js --alias:form-data=./shims/empty.js \
  --alias:tizen=$I/tizen --alias:node-forge=$I/node-forge --alias:@xmldom/xmldom=$I/@xmldom/xmldom --alias:buffer=$I/buffer \
  --inject:./shims/process.js --log-level=warning
