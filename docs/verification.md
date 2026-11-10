# Foundation delivery evidence

## Build artifacts

- [Corrected signed build 11](https://github.com/tingkai-c/zorid-mobile/actions/runs/42904317752): built from `37fcfe2`, includes the native Authorization header declaration required for pairing. Downloaded checksum, packaged update configuration, and app/extension profile device/App Group permissions were verified. Installed over the existing app through the connected Mac using `devicectl`; device app info confirmed bundle version 11, and a subsequent process query confirmed Zorid remained running. Visual pairing state, OTA application and offline relaunch still need device acceptance.
- [Signed device build](https://github.com/tingkai-c/zorid-mobile/actions/runs/42900234919): successful archive and ad-hoc IPA export from `cd609e9`. Download `zorid-device-10` from the run's artifacts. Artifacts expire after seven days; retain a local copy.
- The downloaded IPA checksum matched `SHA256SUMS`. Both embedded provisioning profiles match the app/extension bundle IDs, contain `group.app.zorid.mobile`, include the intended registered iPhone, are unexpired, and disallow development debugging. This is profile inspection, not physical-device runtime validation.
- [Simulator build](https://github.com/tingkai-c/zorid-mobile/actions/runs/42896059984): compilation succeeded and `zorid-simulator-6` was uploaded; the subsequent installation smoke test timed out.
- [Smoke-only retry](https://github.com/tingkai-c/zorid-mobile/actions/runs/42901137317): installation succeeded with a longer timeout, but `simctl launch` timed out after 60 seconds. The failure screenshot shows Zorid installed on the simulator home screen. App launch and UI behavior remain unverified; this does not establish whether the cause is the app or the hosted simulator.
- [Foundation CI](https://github.com/tingkai-c/zorid-mobile/actions/runs/42901209944): passed at `6c64a10`, including the automated foundation checks. Local verification also covered 19 Bun tests (62 assertions), typecheck, lint, Expo Doctor, JavaScript exports, and PostgreSQL migration/constraint checks.

## Remaining acceptance work

Build 11 is installed and launched on the registered iPhone. Verify pairing, offline restart, persisted tasks/timer history, native widgets/Live Activities, and signed JavaScript update/recovery behavior. See [installation instructions](ios-builds.md#installation-and-acceptance) and [host pairing](host.md).

The backend currently supplies a PostgreSQL schema and constraint tests. Cross-device data synchronization and its authenticated API are not implemented. The widget renderer and Focus example are a foundation, not a general widget editor.
