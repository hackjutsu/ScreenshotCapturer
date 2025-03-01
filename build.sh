#!/bin/bash

# Create build directory if it doesn't exist
mkdir -p dist

# Remove any existing zip file
rm -f dist/screenshot-capturer.zip

# Create a zip file of the extension
zip -r dist/screenshot-capturer.zip \
  manifest.json \
  popup.html \
  popup.css \
  popup.js \
  background.js \
  content.js \
  screenshot-viewer.html \
  screenshot-viewer.js \
  privacy_policy.md \
  README.md \
  icons/ \
  -x "*.DS_Store" "*.git*"

echo "Extension packaged successfully at dist/screenshot-capturer.zip"