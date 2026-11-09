#!/bin/sh
# Builds the Chrome Web Store upload: only the files the extension runs (no tests, no store assets).
set -eu
cd "$(dirname "$0")"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="awesome-bookmarks-$version.zip"
rm -f "$out"
zip -qr "$out" manifest.json ./*.html ./*.css ./*.js icons
if grep -q 'YOUR_CLIENT_ID' manifest.json; then
  echo "Note: the Google Calendar client ID is still a placeholder, so the calendar widget stays off." >&2
fi
echo "$out"
