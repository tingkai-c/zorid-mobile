#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${IOS_CERTIFICATE_P12_BASE64:?Missing signing certificate}"
: "${IOS_CERTIFICATE_PASSWORD:?Missing certificate password}"
: "${IOS_TEAM_ID:?Missing team ID}"
mkdir -p "$RUNNER_TEMP/zorid-signing"
python3 scripts/ios/prepare-signing.py
node scripts/ios/check-api-access.mjs
signing_dir="$RUNNER_TEMP/zorid-signing"
keychain="$signing_dir/build.keychain-db"
keychain_password="$(openssl rand -hex 32)"
printf '%s' "$keychain" > "$signing_dir/keychain-path"
security create-keychain -p "$keychain_password" "$keychain" >/dev/null 2>&1
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$signing_dir/certificate.p12" -P "$IOS_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain" >/dev/null 2>&1
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null 2>&1
security list-keychains -d user -s "$keychain" login.keychain-db
python3 scripts/ios/select-signing-identity.py
ruby scripts/ios/configure-signing.rb
rm -f "$signing_dir/certificate.p12"
