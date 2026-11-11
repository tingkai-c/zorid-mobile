# iOS builds and installation

Development, dependency installs, tests and JavaScript export run on WSL. GitHub builds native iOS applications. The Mac downloads the signed IPA and installs it on a registered phone; no local compilation is required.

## Workflows and artifacts

`Check foundation` runs Bun tests, TypeScript, ESLint and iOS JavaScript export on Ubuntu for pushes and pull requests. Its artifact is an export, not an installable application. An independent job starts an ephemeral PostgreSQL 18 service, applies the migration to an empty database and runs the transactional schema constraint checks. The CI password is disposable and is not a production credential.

Manually run `Build iOS`, selecting:

- `simulator` (default): unsigned Release build containing the widget, Device Activity Monitor and two shield extensions, packaged as `Zorid-simulator.zip`. It cannot install on a physical iPhone. The workflow then boots an available iPhone simulator, installs the app, verifies that launch returns a PID and that the process survives ten seconds, and captures a screenshot. Build logs, the Xcode result bundle, screenshot and smoke result are separate diagnostic artifacts. Shutdown runs even if installation/launch fails. A successful smoke result does not assert app behavior; inspect the screenshot and perform device acceptance separately.
- `device`: signed registered-device Release archive exported as `Zorid.ipa`. Install on a phone included in all five provisioning profiles. IPA, checksum and commit/run metadata form the downloadable artifact.
- `testflight`: signed Release archive uploaded to App Store Connect for internal TestFlight testing. The Actions artifact is an upload receipt with the commit, run and build number. Install the processed build from TestFlight on the iPhone.

```sh
gh workflow run ios.yml -f mode=simulator
gh run list --workflow ios.yml
gh run download RUN_ID --name zorid-simulator-RUN_NUMBER
# After signing secrets are configured:
gh workflow run ios.yml -f mode=device
gh workflow run ios.yml -f mode=testflight
```

To retry simulator installation without recompiling, run `gh workflow run ios-smoke.yml -f run_id=BUILD_RUN_ID`. It verifies and reuses the simulator ZIP from that run. First installation is bounded at five minutes; failures retain simulator diagnostics and attempt a screenshot.

Artifacts expire after seven days. The workflow does not publish GitHub Releases or upload the Xcode archive. Signed build logs/result bundles remain on the disposable runner because they can contain provisioning metadata. Failures emit fixed diagnostic categories matched against error lines, with private-log line numbers; raw free-form profile/certificate names are never echoed. A signed IPA necessarily embeds provisioning profiles, including registered-device identifiers; Actions artifacts in a public repository must not be treated as private storage. No separate profiles, keys or passwords are uploaded.

## Toolchain

Expo SDK 58 / React Native 0.88 require Xcode 27 here. The workflow fails early on an older version. It uses GitHub's standard `xcode-27` preview runner, not `xcode-27-xlarge`. Preview capacity or image changes can affect builds. `ios/` is generated using Expo prebuild. Put durable native changes in app config or config plugins.

Sources checked:

- [Expo SDK 58](https://expo.dev/changelog/sdk-58)
- [GitHub Xcode 27 runner announcement and label](https://github.com/actions/runner-images/issues/14404)
- [macOS 26 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) defaults to Xcode 26, so is not used here.

## Private signing diagnostics

Optionally set public repository variable `ZORID_DIAGNOSTIC_CERTIFICATE_BASE64` to a base64 PEM RSA recipient certificate. Keep its private key on the operator machine, never in GitHub. Failed device builds encrypt only the signing archive/export logs using OpenSSL CMS with AES-256, upload only `private-diagnostics.cms`, and retain that ciphertext artifact for three days. The temporary plaintext tarball is deleted immediately; original logs are removed by signing cleanup. The public job still emits only fixed diagnostic categories.

Download and decrypt on the private operator machine, into a restricted directory:

```sh
umask 077
openssl cms -decrypt -binary -inform DER -in private-diagnostics.cms \
  -inkey /private/path/key.pem -out signing-logs.tar.gz
```

Do not repost decrypted logs or upload them as artifacts: they can contain account and provisioning metadata.

## Public update trust anchor

Set repository variables `ZORID_UPDATE_URL` and `ZORID_UPDATE_CERTIFICATE_BASE64` together. The first is the paired host's HTTPS update endpoint; the second is base64 of its public PEM signing certificate, never the private signing key. The workflow decodes the certificate into runner temporary storage and passes `ZORID_UPDATE_CERTIFICATE` and `ZORID_UPDATE_URL` to Expo prebuild. An incomplete pair fails the build; with neither set, the app config's unpaired defaults apply.

## Signing

Set these repository Actions secrets from trusted credential automation; never commit or print their contents:

| Secret | Meaning |
| --- | --- |
| `IOS_CERTIFICATE_P12_BASE64` | Base64 PKCS#12 with Apple Distribution certificate and private key |
| `IOS_CERTIFICATE_PASSWORD` | PKCS#12 password |
| `IOS_TEAM_ID` | Paid Apple Developer team |
| `IOS_PROFILES_ZIP_BASE64` | Base64 ZIP of app, widget, focus monitor and two shield ad-hoc provisioning profiles |
| `IOS_APP_STORE_PROFILES_ZIP_BASE64` | Base64 ZIP of app, widget, focus monitor and two shield App Store Connect provisioning profiles for TestFlight |

Profile secrets accept either a ZIP or a gzip-wrapped ZIP before base64 encoding. The gzip wrapper lets the five profiles fit GitHub's secret value limit by compressing their shared certificate and metadata together. The current TestFlight secret uses a gzip-wrapped, `ZIP_STORED` archive prepared and encrypted on the Mac; plaintext profiles were not transferred through WSL. Both consumers bound the expanded ZIP to 16 MiB and continue to accept existing unwrapped ZIP inputs. Create the archive and encrypt the GitHub secret on the trusted credential machine; do not relay plaintext profiles through development logs.

Expected bundle IDs are `app.zorid.mobile`, `app.zorid.mobile.widgets`, `app.zorid.mobile.focus-monitor`, `app.zorid.mobile.shield-configuration` and `app.zorid.mobile.shield-action`, sharing `group.app.zorid.mobile`. Each target needs its own profile authorizing Family Controls distribution, the App Group, its exact bundle ID and the signing certificate. Registered-device profiles must also include the intended phone. A wildcard development profile is insufficient. Adding a phone requires regenerating registered-device profiles and rebuilding.

Family Controls distribution access must be approved before compatible profiles can be generated for TestFlight. The entitlement request was submitted with the account holder's consent. The subsequent Developer Portal configuration shows Family Controls (Distribution) as Assigned and enabled on all five identifiers. The [runner readiness check](https://github.com/tingkai-c/zorid-mobile/actions/runs/43074465570) verified regenerated TestFlight profiles for all five targets: present, Family Controls enabled, shared App Group enabled, App Store distribution and unexpired. Its [downloadable capability receipt](https://github.com/tingkai-c/zorid-mobile/actions/runs/43074465570/artifacts/13882615266) reports `ready: true`. This checks profiles, not successful archive signing or installation. Run `gh workflow run screen-time-access.yml` to repeat it without exposing profile contents. The separate ad-hoc secret still contains the older profiles and needs a new five-target registered-device archive before `device` mode is usable. See [Screen Time delivery and device limitations](screen-time.md#signing-and-delivery).

Profiles are installed under `~/Library/Developer/Xcode/UserData/Provisioning Profiles`, the Xcode 16+ location used by [Fastlane](https://github.com/fastlane/fastlane/blob/master/fastlane_core/lib/fastlane_core/provisioning_profile.rb). Cleanup removes the exact installed paths. The script rejects expired, wildcard, development and wrong-team profiles, then assigns each target its own profile by bundle ID. After certificate import, it requires exactly one valid identity in the isolated keychain and privately pins manual target signing and IPA export to that certificate SHA-1 fingerprint. This supports both legacy iPhone Distribution and Apple Distribution certificate names without printing their names or fingerprints. Xcode validates remaining entitlement/certificate compatibility. Profiles must remain valid at installation and use.

Without the profile ZIP, automatic provisioning requires `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`, and `ASC_API_ISSUER_ID`: a team App Store Connect API key with adequate Developer Resources permissions. Before archiving, a read-only API preflight verifies access to app identifiers, certificates and devices using the exact runner credentials, printing only HTTP status codes. Successful reads do not prove write/capability permissions. Xcode receives `-allowProvisioningUpdates` and may create/update application-specific provisioning resources. This does not guarantee registration of every capability or App Group; supply explicit profiles if Xcode cannot do it. Automatic archives use Apple Development signing; export selects the available distribution signing identity for registered-device installation. Xcode may create a development certificate when the runner has none, so prefer reusable credentials/manual profiles for repeated builds rather than accumulating certificates. The distribution certificate is required in either branch. Apple documents the authentication flags in [Distribute apps in Xcode with cloud signing](https://developer.apple.com/videos/play/wwdc2021/10204/).

Secrets are decoded in a restricted runner temporary directory and imported into a temporary keychain. Unconditional cleanup removes that keychain, input profiles, decoded secrets and signing logs. Only trusted workflow revisions should receive secrets.

## Internal TestFlight

Create the `app.zorid.mobile` app record in App Store Connect and add the intended account to an internal TestFlight group. Enable automatic distribution to deliver future builds to that group after Apple processes them. The app, widget, focus monitor and both shield extensions need App Store Connect profiles signed by the same distribution identity and authorized for Family Controls and the shared App Group. The runner uses `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID` and `ASC_API_ISSUER_ID` for upload. A new workflow dispatch allocates a new build number.

On the iPhone, open the TestFlight invitation with the invited Apple Account, then install Zorid from TestFlight. Beta builds expire after 90 days. Use the paired host for JavaScript releases and dispatch a new TestFlight build for native changes. See [Apple's internal testing setup](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/).

The Screen Time extensions and [UIKit haptics bridge](haptics.md) first ship in runtime `zorid-4`. [TestFlight build 27](https://github.com/tingkai-c/zorid-mobile/actions/runs/43076740068) compiled, signed all five targets and uploaded from `3d2752104ea74f9658e79fcffc4564e3ea90f99e`; its [upload receipt](https://github.com/tingkai-c/zorid-mobile/actions/runs/43076740068/artifacts/13883951126) is downloadable. Builds 25 and 26 were canceled after haptic changes. The [Apple status check](https://github.com/tingkai-c/zorid-mobile/actions/runs/43083579423) confirms build 27 is valid and assigned to internal testing. Runtime `zorid-5` additionally installs advanced Core Haptics, the [device bridge](device.md) and [common Expo capabilities](device-expo.md); these APIs require the compatible new binary. [Build 28](https://github.com/tingkai-c/zorid-mobile/actions/runs/43083842780) compiled, signed and uploaded those runtime `zorid-5` capabilities; its [upload receipt](https://github.com/tingkai-c/zorid-mobile/actions/runs/43083842780/artifacts/13887950499) was verified. The matching signed OTA release is published. Apple processing and physical installation remain separate from successful upload. See [current delivery evidence](verification.md).

Check processing and internal-group assignment without a Mac connection with `gh workflow run testflight-status.yml -f build=BUILD_NUMBER`. This read-only Ubuntu job uses the existing API secrets only in the runner step. Its downloadable JSON receipt contains the requested build number, fixed processing/audience/testing states and an internal-group membership flag. If Apple has not listed the build yet, it checks the [upload-processing status](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-builduploads) and reports only its fixed state; an empty result stays unknown. Successful upload alone does not establish tester availability. The job never assigns builds or prints API identifiers, credentials or personal response fields. Failed requests identify only the fixed endpoint name and numeric HTTP status.

## Installation and acceptance

Download/extract the device artifact. Use Apple Configurator's Add → Apps → Choose from my Mac flow with the connected registered iPhone. Enable Developer Mode if iOS asks. No source checkout or CocoaPods is needed on the Mac.

If full Xcode is already installed, the lightweight command-line alternative is `bash scripts/ios/install-mac.sh Zorid.ipa DEVICE-ID EXPECTED-SHA256`. It verifies the optional checksum, extracts the app, installs it over the existing version, and launches it without compiling. Keep the phone unlocked and approve Trust if prompted. Obtain its identifier with `xcrun devicectl list devices`; standalone Command Line Tools do not include `devicectl`. See [Apple's device command-line guide](https://developer.apple.com/documentation/xcode/interacting-with-devices-using-the-command-line).

Simulator compilation does not prove device installation; signing does not prove launch behavior. Device acceptance still needs pairing over Tailscale, offline startup, SQLite persistence, update compatibility/rollback and actual widget/Live Activity rendering. New native capabilities or extension changes require a native rebuild; JavaScript releases come directly from the paired host.

### Repeated installation from WSL

After authorizing a dedicated SSH key on the Mac, keep its connection details in the private, mode-0600 file `~/.local/share/zorid/macos-install-private.json`. Required fields are `host`, `user`, `identityFile` and `deviceIdentifier` (from CoreDevice discovery). Never commit or print this file.

Run `python3 scripts/ios/install-remote.py path/to/Zorid.ipa` on WSL; `--config` selects another private config file. The helper computes the IPA checksum, transfers it and the Mac installer through SSH, installs over the existing app, launches it, and removes its temporary Mac transfer directory. Detailed command output stays in a mode-0600 local log; public progress omits device and account metadata. The Mac must remain awake and reachable, with the iPhone connected and unlocked. This does not build anything on the Mac or uninstall the existing app.
