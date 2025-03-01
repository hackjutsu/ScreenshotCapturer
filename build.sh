#!/bin/bash

# Create build directory if it doesn't exist
mkdir -p dist

# Remove any existing zip file
rm -f dist/screenshot-extension.zip

# Create a zip file of the extension
zip -r dist/screenshot-extension.zip \
  manifest.json \
  popup.html \
  popup.css \
  popup.js \
  background.js \
  content.js \
  screenshot-viewer.html \
  screenshot-viewer.js \
  icons/ \
  -x "*.DS_Store" "*.git*"

echo "Extension packaged successfully at dist/screenshot-extension.zip"