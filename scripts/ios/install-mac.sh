#!/bin/bash
# Install an already-built app on a specific registered iPhone; never compile or uninstall.
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo 'Run this installer on the Mac connected to your iPhone.' >&2
  exit 1
fi
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo 'Usage: bash install-mac.sh APP.ipa DEVICE-ID [EXPECTED-SHA256]' >&2
  exit 1
fi
ipa="$1"
device="$2"
if [ ! -f "$ipa" ]; then
  echo 'The IPA file does not exist.' >&2
  exit 1
fi
if [ "$#" -eq 3 ]; then
  actual=$(shasum -a 256 "$ipa" | awk '{print $1}')
  if [ "$actual" != "$3" ]; then
    echo 'IPA checksum does not match; installation stopped.' >&2
    exit 1
  fi
fi
if ! xcrun --find devicectl >/dev/null 2>&1; then
  echo 'devicectl is unavailable. If full Xcode is installed, select it as the active developer directory.' >&2
  echo 'Otherwise install the IPA using Apple Configurator: Add > Apps > Choose from my Mac.' >&2
  exit 1
fi

staging=$(mktemp -d "${TMPDIR:-/tmp}/zorid-install.XXXXXX")
trap 'rm -rf "$staging"' EXIT
ditto -x -k "$ipa" "$staging"
apps=("$staging"/Payload/*.app)
if [ "${#apps[@]}" -ne 1 ] || [ ! -d "${apps[0]}" ]; then
  echo 'Expected exactly one app in the IPA.' >&2
  exit 1
fi
echo 'Keep the iPhone unlocked; approve Trust if it appears.'
echo 'Installing Zorid over the existing app…'
xcrun devicectl device install app --device "$device" "${apps[0]}"
echo 'Launching Zorid…'
xcrun devicectl device process launch --device "$device" app.zorid.mobile
