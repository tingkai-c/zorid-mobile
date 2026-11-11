# Foundation delivery evidence

## Focus completion state

The Live Activity now has a separate completion layout for completed records and running snapshots marked stale by iOS. It shows a checkmark, “Focus complete,” the task and focused duration. Early finishes use actual elapsed work; deadline expiry uses the remaining countdown plus already accumulated work. All completion regions omit countdowns and action buttons. The compact Island uses a bounded “Done” label.

The serialized Expo layout tests were red before the change (four completion failures) and now pass all 14 cases with 474 assertions. The full JavaScript suite passes 89 tests with 831 assertions; typecheck, lint and action-bundle freshness pass. The native adapter ends with final content and iOS's default dismissal policy instead of immediate removal. A new native binary is needed for that retention behavior; the layout uses existing Expo components and the action source remains unchanged.

No post-change iPhone screenshot is available. Serialized-layout checks do not establish native visual appearance or exact deadline refresh timing. The planned TestFlight build replaces canceled build 21 and includes both the Pause runtime repair and completion behavior.

## Pause action investigation

The phone reported “The app action failed; no changes were saved” when pausing inside Zorid. This identifies a JavaScript handler exception, rather than a post-commit widget refresh failure. The exact phone-side cause remains unconfirmed because the Mac was unreachable for diagnostics.

- [Pre-fix native reproduction](https://github.com/tingkai-c/zorid-mobile/actions/runs/43054097743): the original 73 native checks passed, then the actual compiled Focus handler rejected a fresh app-side revision with the same generic error. Raw decimal JSON passed through Foundation's number conversion produced a different JavaScript number. Nine of 4,028 synthetic timestamp cases differed. The diagnostic branch deliberately retains the previous runtime and must not be shipped.
- [Corrected native checks](https://github.com/tingkai-c/zorid-mobile/actions/runs/43053834915): 99 action checks, the compiled Pause/Resume/Finish lifecycle, the new fresh-revision Pause regression, and all 4,028 numeric comparisons passed. Record reads now parse their original JSON in JavaScriptCore, matching JavaScript record semantics. Captured parser references prevent handler replacement of `JSON.parse` from changing record reads.
- Handler exceptions retain bounded own error messages without invoking ordinary message getters or custom string conversion. Unsafe values use the generic fallback. Native capability errors retain precedence. Regression checks verify record/effect rollback and the absence of a receipt for failed actions.
- All 82 JavaScript tests passed, including eight status-reporting tests, with 475 Bun assertions; typecheck, lint, generated-handler freshness and iOS export passed. Independent review found no material issue.

The stock demo creates integer timestamps, including native action timestamps. The fractional-number defect is reproduced and fixed, but does not establish why this particular phone failed. The updated native error message is needed to distinguish a stale button from other handler failures on the device. The JavaScript action bundle remains `focus-actions-1`; its code has not changed.

## Widget storage and Lock Screen repair

Commit `2508dd5` removes the legacy `UserDefaults.synchronize()` reload prerequisite. The [native reproduction](https://github.com/tingkai-c/zorid-mobile/actions/runs/43044485526) ran the actual extracted Swift method with real Foundation defaults: the timeline read back correctly, but a false legacy flush result raised `Shared widget storage is unavailable.` and skipped reload. The [corrected native regression](https://github.com/tingkai-c/zorid-mobile/actions/runs/43045681679) passes accepted writes and retains distinct failures for missing defaults and missing layouts. This proves that false-error path; it is not a captured trace of the user's phone.

The user's Lock Screen screenshot confirmed dark green labels on a black card and a narrow centered stack. The revised layout pairs background/foreground colors, places title/status beside a bounded countdown and controls below, and gives Dynamic Island its own readable colors and compact sizing. [Foundation CI](https://github.com/tingkai-c/zorid-mobile/actions/runs/43045682030) passed 74 Bun tests with 475 assertions, typecheck, lint, PostgreSQL checks and iOS export. Ten tests evaluate the actual installed Expo widget serializer/runtime for contrast, countdown bounds, action-target preservation and stale controls. The [JavaScript export artifact](https://github.com/tingkai-c/zorid-mobile/actions/runs/43045682030/artifacts/13866728337) is downloadable.

The original device screenshot is private and is not committed or included in public artifacts. No post-update device screenshot is available, so actual Lock Screen appearance remains an acceptance check. Existing simulator install/launch timeouts make the old smoke harness insufficient for ActivityKit visual acceptance.

TestFlight build 20 compiled, signed and uploaded from `2508dd5`; its [upload receipt](https://github.com/tingkai-c/zorid-mobile/actions/runs/43045494030/artifacts/13868626317) is downloadable. The full native workflow also passed the widget-storage regressions, 73 core checks, the compiled Focus lifecycle, eight queue recovery scenarios and route persistence checks.

App Store Connect confirmed processing `VALID`, audience `INTERNAL_ONLY`, internal state `IN_BETA_TESTING` and assignment to the existing internal group. The group has access to all builds: automatic assignment lagged initial processing readiness. A manual relationship-add request was rejected with `ENTITY_UNPROCESSABLE` because this group receives builds automatically; the subsequent read confirmed the build was assigned without that mutation.

Runtime `zorid-3` release `1000e988-5b48-40f7-a652-caf8747c629c` was published at 2026-11-11 15:25:07 UTC, after build 20 finished. An authenticated probe verified its RSA signature, all 24 asset hashes and the newer-than-embedded timestamp rule; temporary probe credentials were revoked. Earlier visual release `52c7da25-ad8b-42cc-98eb-7475950144aa` supplied the same layout to existing build 19 installations while the native build ran.

## Downloaded actions, shortcuts and deep links

Implementation `81765a5` adds the shared JavaScriptCore action runtime, App Group SQLite migration, durable action receipts and surface effects, Home Screen quick actions and queued custom-scheme routes. The Focus demo exercises Pause, Resume and Finish from the app, widget and Live Activity.

[Foundation CI](https://github.com/tingkai-c/zorid-mobile/actions/runs/42964110273) passed: 64 Bun tests with 357 assertions, typecheck, lint, generated handler freshness, PostgreSQL schema checks and iOS JavaScript export. [Download the JavaScript export](https://github.com/tingkai-c/zorid-mobile/actions/runs/42964110273/artifacts/13830746056).

Native checks on [the macOS runner](https://github.com/tingkai-c/zorid-mobile/actions/runs/42964110769) passed: 73 core checks for actual JavaScriptCore/SQLite execution and legacy WAL migration, the compiled Focus lifecycle, route persistence and eight surface-effect failure/recovery scenarios. In particular, a rejected Live Activity start cannot block a later widget update; pending work retains a bounded continuation cursor.

Physical-device acceptance remains for widget/Live Activity buttons, locked-device behavior, actual timeline refresh, cold/warm navigation and the Home Screen menu. These checks do not establish those device behaviors. Independent app bundles, universal links and cross-device data synchronization remain unimplemented.

TestFlight build 19 compiled, signed and uploaded successfully. Its [upload receipt](https://github.com/tingkai-c/zorid-mobile/actions/runs/42964110769/artifacts/13830918675) identifies implementation commit `81765a5`. A separate App Store Connect API check confirmed processing `VALID`, audience `INTERNAL_ONLY`, internal state `IN_BETA_TESTING` and assignment to the internal testing group.

Published runtime `zorid-3` release `7aebda75-0715-4cbc-9665-6148c90b579e` at 2026-11-11 05:28:58 UTC, after the native workflow completed. An authenticated probe through the actual Tailscale HTTPS endpoint verified the manifest's RSA signature, all 24 asset hashes and the newer-than-embedded timestamp rule. Temporary probe credentials were revoked. Publication does not establish application on a physical device.

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
