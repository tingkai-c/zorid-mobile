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
elif [[ "$BUILD_MODE" == device || "$BUILD_MODE" == testflight ]]; then
  umask 077
  signing_dir="$RUNNER_TEMP/zorid-signing"
  if [[ "$BUILD_MODE" == testflight && ! -f "$signing_dir/api.json" ]]; then
    echo 'Missing App Store Connect upload credentials' >&2
    exit 1
  fi
  # macOS ships Bash 3.2: an empty array expansion is unbound under set -u.
  # The TestFlight archive signs with installed profiles; only its export contacts Apple.
  xcodebuild_with_provisioning() {
    if [[ -f "$signing_dir/api.json" && ( "$BUILD_MODE" == device || "$1" == -exportArchive ) ]]; then
      xcodebuild "$@" -allowProvisioningUpdates \
        -authenticationKeyPath "$signing_dir/AuthKey.p8" \
        -authenticationKeyID "$(python3 -c 'import json,os; print(json.load(open(os.environ["RUNNER_TEMP"]+"/zorid-signing/api.json"))["keyId"])')" \
        -authenticationKeyIssuerID "$(python3 -c 'import json,os; print(json.load(open(os.environ["RUNNER_TEMP"]+"/zorid-signing/api.json"))["issuerId"])')"
    else
      xcodebuild "$@"
    fi
  }
  # Keep signing diagnostics on the ephemeral runner: these may contain profile metadata.
  if ! xcodebuild_with_provisioning -workspace "$workspace" -scheme Zorid -configuration Release \
    -destination 'generic/platform=iOS' -archivePath build/Zorid.xcarchive \
    -resultBundlePath build/Build.xcresult archive > build/signing-build.log 2>&1; then
    python3 scripts/ios/diagnose-build.py build/signing-build.log >&2
    exit 1
  fi
  if ! xcodebuild_with_provisioning -exportArchive -archivePath build/Zorid.xcarchive \
    -exportOptionsPlist "$signing_dir/ExportOptions.plist" \
    -exportPath build/export > build/signing-export.log 2>&1; then
    python3 scripts/ios/diagnose-build.py build/signing-export.log >&2
    exit 1
  fi
  if [[ "$BUILD_MODE" == device ]]; then
    cp build/export/*.ipa build/artifacts/Zorid.ipa
  else
    echo 'Xcode uploaded the internal TestFlight build to App Store Connect.'
  fi
else
  echo 'Unsupported BUILD_MODE' >&2; exit 1
fi
if [[ "${BUILD_MODE:-simulator}" != testflight ]]; then
  (cd build/artifacts && shasum -a 256 ./* > SHA256SUMS)
fi
printf 'Commit: %s\nRun: %s\nMode: %s\n' "${GITHUB_SHA:-local}" "${GITHUB_RUN_ID:-local}" "${BUILD_MODE:-simulator}" > build/artifacts/build-info.txt
if [[ "${BUILD_MODE:-simulator}" == testflight ]]; then
  printf 'Build: %s\nUpload: internal TestFlight\n' "${GITHUB_RUN_NUMBER:-1}" >> build/artifacts/build-info.txt
fi
