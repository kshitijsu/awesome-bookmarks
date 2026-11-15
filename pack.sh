#!/bin/sh
# Builds the Chrome Web Store upload: only the files the extension runs (no tests, no store assets).
set -eu
cd "$(dirname "$0")"
./configure.sh >/dev/null # manifest.json from the template and .env / OAUTH_CLIENT_ID
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="awesome-bookmarks-$version.zip"
rm -f "$out"
zip -qr "$out" manifest.json ./*.html ./*.css ./*.js icons -x "*.DS_Store"
if grep -q 'YOUR_CLIENT_ID' manifest.json; then
  echo "Note: no OAuth client ID (set OAUTH_CLIENT_ID or .env), so Google Calendar and Drive sync stay off." >&2
fi
echo "$out"
