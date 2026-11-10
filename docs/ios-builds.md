# iOS builds and installation

Development, dependency installs, tests and JavaScript export run on WSL. GitHub builds native iOS applications. The Mac downloads the signed IPA and installs it on a registered phone; no local compilation is required.

## Workflows and artifacts

`Check foundation` runs Bun tests, TypeScript, ESLint and iOS JavaScript export on Ubuntu for pushes and pull requests. Its artifact is an export, not an installable application.

Manually run `Build iOS`, selecting:

- `simulator` (default): unsigned Release build containing the native widget extension, packaged as `Zorid-simulator.zip`. It cannot install on a physical iPhone. Build logs and the Xcode result bundle are separate diagnostic artifacts.
- `device`: signed registered-device Release archive exported as `Zorid.ipa`. Install on a phone included in both provisioning profiles. IPA, checksum and commit/run metadata form the downloadable artifact.

```sh
gh workflow run ios.yml -f mode=simulator
gh run list --workflow ios.yml
gh run download RUN_ID --name zorid-simulator-RUN_NUMBER
# After signing secrets are configured:
gh workflow run ios.yml -f mode=device
```

Artifacts expire after seven days. The workflow does not publish GitHub Releases or upload the Xcode archive. Signed build logs/result bundles remain on the disposable runner because they can contain provisioning metadata. Failures emit fixed diagnostic categories matched against error lines, with private-log line numbers; raw free-form profile/certificate names are never echoed. A signed IPA necessarily embeds provisioning profiles, including registered-device identifiers; Actions artifacts in a public repository must not be treated as private storage. No separate profiles, keys or passwords are uploaded.

## Toolchain

Expo SDK 58 / React Native 0.88 require Xcode 27 here. The workflow fails early on an older version. It uses GitHub's standard `xcode-27` preview runner, not `xcode-27-xlarge`. Preview capacity or image changes can affect builds. `ios/` is generated using Expo prebuild. Put durable native changes in app config or config plugins.

Sources checked:

- [Expo SDK 58](https://expo.dev/changelog/sdk-58)
- [GitHub Xcode 27 runner announcement and label](https://github.com/actions/runner-images/issues/14404)
- [macOS 26 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) defaults to Xcode 26, so is not used here.

## Public update trust anchor

Set repository variables `ZORID_UPDATE_URL` and `ZORID_UPDATE_CERTIFICATE_BASE64` together. The first is the paired host's HTTPS update endpoint; the second is base64 of its public PEM signing certificate, never the private signing key. The workflow decodes the certificate into runner temporary storage and passes `ZORID_UPDATE_CERTIFICATE` and `ZORID_UPDATE_URL` to Expo prebuild. An incomplete pair fails the build; with neither set, the app config's unpaired defaults apply.

## Signing

Set these repository Actions secrets from trusted credential automation; never commit or print their contents:

| Secret | Meaning |
| --- | --- |
| `IOS_CERTIFICATE_P12_BASE64` | Base64 PKCS#12 with Apple Distribution certificate and private key |
| `IOS_CERTIFICATE_PASSWORD` | PKCS#12 password |
| `IOS_TEAM_ID` | Paid Apple Developer team |
| `IOS_PROFILES_ZIP_BASE64` | Base64 ZIP of app and widget ad-hoc provisioning profiles |

Expected bundle IDs are `app.zorid.mobile` and `app.zorid.mobile.widgets`, sharing `group.app.zorid.mobile`. Profiles must authorize the App Group, exact bundle IDs, certificate and registered devices. A wildcard development profile is insufficient. Adding a phone requires regenerating profiles and rebuilding.

The script rejects expired, wildcard, development and wrong-team profiles, then assigns each target its own profile by bundle ID. Xcode validates remaining entitlement/certificate compatibility. Profiles must remain valid at installation and use.

Without the profile ZIP, automatic provisioning requires `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`, and `ASC_API_ISSUER_ID`: a team App Store Connect API key with adequate Developer Resources permissions. Xcode receives `-allowProvisioningUpdates` and may create/update application-specific provisioning resources. This does not guarantee registration of every capability or App Group; supply explicit profiles if Xcode cannot do it. The distribution certificate is required in either branch. Apple documents the authentication flags in [Distribute apps in Xcode with cloud signing](https://developer.apple.com/videos/play/wwdc2021/10204/).

Secrets are decoded in a restricted runner temporary directory and imported into a temporary keychain. Unconditional cleanup removes that keychain, input profiles, decoded secrets and signing logs. Only trusted workflow revisions should receive secrets.

## Installation and acceptance

Download/extract the device artifact. Use Apple Configurator's Add → Apps → Choose from my Mac flow with the connected registered iPhone. Enable Developer Mode if iOS asks. No source checkout or CocoaPods is needed on the Mac.

Simulator compilation does not prove device installation; signing does not prove launch behavior. Device acceptance still needs pairing over Tailscale, offline startup, SQLite persistence, update compatibility/rollback and actual widget/Live Activity rendering. New native capabilities or extension changes require a native rebuild; JavaScript releases come directly from the paired host.
