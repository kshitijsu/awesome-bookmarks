#!/bin/sh
# Writes manifest.json from manifest.template.json, filling in the Google OAuth client ID from the
# OAUTH_CLIENT_ID environment variable or, if that's unset, from .env. Without one, Google features stay off.
# Chrome reads the ID from manifest.json itself (extensions have no environment at runtime), so this runs
# before loading the extension unpacked and before packing. .env is read as data, never run.
set -eu
cd "$(dirname "$0")"
id="${OAUTH_CLIENT_ID:-}"
if [ -z "$id" ] && [ -f .env ]; then
  id=$(sed -n 's/^[[:space:]]*OAUTH_CLIENT_ID[[:space:]]*=[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}[[:space:]]*$/\1/p' .env | tail -n 1)
fi
if [ -n "$id" ]; then
  # Checked before it goes into sed: digits-letters.apps.googleusercontent.com and nothing else.
  if ! printf '%s' "$id" | grep -Eq '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'; then
    echo "OAUTH_CLIENT_ID doesn't look like a Google OAuth client ID (…apps.googleusercontent.com)." >&2
    exit 1
  fi
  sed "s/YOUR_CLIENT_ID\.apps\.googleusercontent\.com/$id/" manifest.template.json > manifest.json
else
  cp manifest.template.json manifest.json
  echo "No OAUTH_CLIENT_ID set: Google Calendar and Drive sync stay off." >&2
fi
echo "Wrote manifest.json"
