# Foundation delivery evidence

## Build artifacts

- [Signed device build](https://github.com/tingkai-c/zorid-mobile/actions/runs/42900234919): successful archive and ad-hoc IPA export from `cd609e9`. Download `zorid-device-10` from the run's artifacts. Artifacts expire after seven days; retain a local copy.
- The downloaded IPA checksum matched `SHA256SUMS`. Both embedded provisioning profiles match the app/extension bundle IDs, contain `group.app.zorid.mobile`, include the intended registered iPhone, are unexpired, and disallow development debugging. This is profile inspection, not physical-device runtime validation.
- [Simulator build](https://github.com/tingkai-c/zorid-mobile/actions/runs/42896059984): compilation succeeded and `zorid-simulator-6` was uploaded; the subsequent installation smoke test timed out.
- [Smoke-only retry](https://github.com/tingkai-c/zorid-mobile/actions/runs/42901137317): installation succeeded with a longer timeout, but `simctl launch` timed out after 60 seconds. The failure screenshot shows Zorid installed on the simulator home screen. App launch and UI behavior remain unverified; this does not establish whether the cause is the app or the hosted simulator.
- [Foundation CI](https://github.com/tingkai-c/zorid-mobile/actions/runs/42901209944): passed at `6c64a10`, including the automated foundation checks. Local verification also covered 19 Bun tests (62 assertions), typecheck, lint, Expo Doctor, JavaScript exports, and PostgreSQL migration/constraint checks.

## Remaining acceptance work

Install the signed IPA on the registered iPhone and verify launch, pairing, offline restart, persisted tasks/timer history, native widgets/Live Activities, and signed JavaScript update/recovery behavior. See [installation instructions](ios-builds.md#installation-and-acceptance) and [host pairing](host.md).

The backend currently supplies a PostgreSQL schema and constraint tests. Cross-device data synchronization and its authenticated API are not implemented. The widget renderer and Focus example are a foundation, not a general widget editor.
