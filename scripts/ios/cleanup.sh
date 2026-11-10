#!/usr/bin/env bash
set -eu
if [[ -f "$RUNNER_TEMP/zorid-signing/keychain-path" ]]; then
  security delete-keychain "$(cat "$RUNNER_TEMP/zorid-signing/keychain-path")" >/dev/null 2>&1 || true
fi
if [[ -f "$RUNNER_TEMP/zorid-signing/installed-profiles" ]]; then
  while IFS= read -r profile; do rm -f "$profile"; done < "$RUNNER_TEMP/zorid-signing/installed-profiles"
fi
rm -rf "$RUNNER_TEMP/zorid-signing"
rm -f build/signing-build.log build/signing-export.log
