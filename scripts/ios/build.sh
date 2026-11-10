#!/usr/bin/env bash
set -euo pipefail
mkdir -p build/artifacts
workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
test -n "$workspace"
if [[ "${BUILD_MODE:-simulator}" == simulator ]]; then
  xcodebuild -workspace "$workspace" -scheme Zorid -configuration Release \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath build/DerivedData \
    -resultBundlePath build/Build.xcresult CODE_SIGNING_ALLOWED=NO build 2>&1 | tee build/build.log
  ditto -c -k --sequesterRsrc --keepParent \
    build/DerivedData/Build/Products/Release-iphonesimulator/Zorid.app \
    build/artifacts/Zorid-simulator.zip
elif [[ "$BUILD_MODE" == device ]]; then
  provision_args=()
  if [[ -f "$RUNNER_TEMP/zorid-signing/api.json" ]]; then
    provision_args=(-allowProvisioningUpdates -authenticationKeyPath "$RUNNER_TEMP/zorid-signing/AuthKey.p8"
      -authenticationKeyID "$(python3 -c 'import json,os; print(json.load(open(os.environ["RUNNER_TEMP"]+"/zorid-signing/api.json"))["keyId"])')"
      -authenticationKeyIssuerID "$(python3 -c 'import json,os; print(json.load(open(os.environ["RUNNER_TEMP"]+"/zorid-signing/api.json"))["issuerId"])')")
  fi
  # Keep signing diagnostics on the ephemeral runner: these may contain profile metadata.
  if ! xcodebuild -workspace "$workspace" -scheme Zorid -configuration Release \
    -destination 'generic/platform=iOS' -archivePath build/Zorid.xcarchive \
    -resultBundlePath build/Build.xcresult "${provision_args[@]}" archive > build/signing-build.log 2>&1; then
    python3 scripts/ios/diagnose-build.py build/signing-build.log >&2
    exit 1
  fi
  if ! xcodebuild -exportArchive -archivePath build/Zorid.xcarchive \
    -exportOptionsPlist "$RUNNER_TEMP/zorid-signing/ExportOptions.plist" \
    -exportPath build/export "${provision_args[@]}" > build/signing-export.log 2>&1; then
    python3 scripts/ios/diagnose-build.py build/signing-export.log >&2
    exit 1
  fi
  cp build/export/*.ipa build/artifacts/Zorid.ipa
else
  echo 'Unsupported BUILD_MODE' >&2; exit 1
fi
(cd build/artifacts && shasum -a 256 ./* > SHA256SUMS)
printf 'Commit: %s\nRun: %s\nMode: %s\n' "${GITHUB_SHA:-local}" "${GITHUB_RUN_ID:-local}" "${BUILD_MODE:-simulator}" > build/artifacts/build-info.txt
