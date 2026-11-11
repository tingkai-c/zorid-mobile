# Foundation delivery evidence

## First download after TestFlight

Published runtime `zorid-2` release `701b32cf-64e9-4333-8bae-bf66a7d192ff` on 2026-11-11 after TestFlight build 16. The previous release predated the new embedded setup bundle and failed Expo's timestamp selection rule. An authenticated HTTPS probe reproduced the rejection, then accepted the fresh release and verified its RSA signature and all 24 asset hashes. The temporary probe credentials were revoked. Applying and launching this release on the physical iPhone still needs device confirmation.

## Build artifacts

- [Signed build 14](https://github.com/tingkai-c/zorid-mobile/actions/runs/42913625544/artifacts/13808458739) packages the SwiftUI Settings shell from `17efd4c`. The IPA checksum, Settings quick action, pinned update trust, and both provisioning profiles were verified. CoreDevice confirmed build 14 installed over build 11 on the registered iPhone. iOS required the phone to be unlocked for remote launch.
- [Corrected signed build 11](https://github.com/tingkai-c/zorid-mobile/actions/runs/42904317752): built from `37fcfe2`, includes the native Authorization header declaration required for pairing. Downloaded checksum, packaged update configuration, and app/extension profile device/App Group permissions were verified. Installed over the existing app through the connected Mac using `devicectl`; device app info confirmed bundle version 11, and a subsequent process query confirmed Zorid remained running. Visual pairing state, OTA application and offline relaunch still need device acceptance.
- [Signed device build](https://github.com/tingkai-c/zorid-mobile/actions/runs/42900234919): successful archive and ad-hoc IPA export from `cd609e9`. Download `zorid-device-10` from the run's artifacts. Artifacts expire after seven days; retain a local copy.
- The downloaded IPA checksum matched `SHA256SUMS`. Both embedded provisioning profiles match the app/extension bundle IDs, contain `group.app.zorid.mobile`, include the intended registered iPhone, are unexpired, and disallow development debugging. This is profile inspection, not physical-device runtime validation.
- [Simulator build](https://github.com/tingkai-c/zorid-mobile/actions/runs/42896059984): compilation succeeded and `zorid-simulator-6` was uploaded; the subsequent installation smoke test timed out.
- [Smoke-only retry](https://github.com/tingkai-c/zorid-mobile/actions/runs/42901137317): installation succeeded with a longer timeout, but `simctl launch` timed out after 60 seconds. The failure screenshot shows Zorid installed on the simulator home screen. App launch and UI behavior remain unverified; this does not establish whether the cause is the app or the hosted simulator.
- [Foundation CI](https://github.com/tingkai-c/zorid-mobile/actions/runs/42901209944): passed at `6c64a10`, including the automated foundation checks. Local verification also covered 19 Bun tests (62 assertions), typecheck, lint, Expo Doctor, JavaScript exports, and PostgreSQL migration/constraint checks.

## Remaining acceptance work

Build 14 is installed on the registered iPhone. Verify launch, the three-finger Settings gesture and haptic, pairing, offline restart, persisted tasks and timer history, native widgets and Live Activities, and signed JavaScript update and recovery. See [installation instructions](ios-builds.md#installation-and-acceptance) and [host pairing](host.md).

The backend currently supplies a PostgreSQL schema and constraint tests. Cross-device data synchronization and its authenticated API are not implemented. The widget renderer and Focus example are a foundation, not a general widget editor.

## First visible OTA release

Commit `af12a5a` removes the repeated product/device label from the shared screen component used by all five routes. Published signed iOS release `80ce8671-35dd-444b-8004-95e55fd1acbf` for runtime `zorid-1`. An authenticated HTTPS probe verified the manifest signature and hashes of the bundle plus 23 assets; the removed header is absent from the published bundle. The temporary probe device was revoked. All 23 tests (92 assertions), typecheck, lint and iOS JavaScript export passed. Applying this release on the phone still requires Settings → Check and download update → Reload and apply update; publication alone does not establish native OTA acceptance.
