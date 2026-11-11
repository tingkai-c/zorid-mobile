# Zorid

An open-source personal workspace for iPhone. Build native-rendered tools in React Native, keep their data on the device, and deliver signed JavaScript releases from your paired laptop over Tailscale.

This foundation includes tasks, a persistent focus timer, work-session history, native host pairing/settings, Focus widgets/Live Activities, and a deployable Screen Time bridge with configurable blocking screens. Runtime `zorid-5` adds custom Core Haptics patterns and common device APIs alongside UIKit feedback. It uses Bun, Expo SDK 58, React Native, and SQLite. PostgreSQL is the future shared-data foundation; cross-device synchronization is **not implemented yet**. See [delivery evidence](docs/verification.md) for confirmed builds and remaining device checks.

## Develop on Linux / WSL

```sh
bun install --frozen-lockfile
bun run start
bun test
bun run typecheck
bun run lint
bun run export:ios
```

Expo Go can preview supported app screens. Signed standalone builds are needed to validate OTA delivery, widgets, and Live Activities. Web is a preview target, not the planned desktop app; see [web preview](docs/web-preview.md) for the SQLite isolation headers it needs.

## Build and install

Run **Build iOS** in GitHub Actions. `simulator` produces a simulator application ZIP; `device` produces a signed IPA for registered devices. Download the artifact from the run. The Mac only needs to install the completed app; compilation happens on the standard GitHub macOS runner.

Use `testflight` for wireless installation through internal TestFlight testing. See [iOS builds](docs/ios-builds.md) for secrets, signing, installation, and runner requirements. A simulator ZIP cannot install on an iPhone. Distribution profiles must cover the main app and all four extensions, Family Controls and the shared App Group. Registered-device profiles must also include the phone.

## Deliver code from your laptop

See [host setup](docs/host.md). The host generates its own update-signing key outside this repository. Build the app with that host's HTTPS `/updates` URL and public certificate, then use Settings to scan its expiring pairing QR.

```sh
bun run host init --url https://your-host.your-tailnet.ts.net:10000
bun run host serve
# In another terminal:
bun run host pair
```

Export with the same update configuration used for the binary. Include the public Expo configuration alongside the bundle before deployment:

```sh
export ZORID_UPDATE_URL=https://your-host.your-tailnet.ts.net:10000/updates
export ZORID_UPDATE_CERTIFICATE="$HOME/.local/share/zorid/certificate.pem"
bun run export:ios
bunx expo config --type public --json | bun -e 'const config = await Bun.stdin.json(); delete config.updates?.codeSigningCertificate; console.log(JSON.stringify(config));' > dist/ios/expoConfig.json
bun run host deploy dist/ios --runtime zorid-5
```

On first launch, native setup pairs and loads the first compatible app. Later launches open the cached app directly. The app controls its full interface, including navigation. Hold three fingers on the screen for one second, or long-press the Home Screen icon → **Zorid Settings**, to check/download/apply later releases. Already cached code and saved tasks work without the host. The phone must be connected to the same tailnet to download. Changing the pinned host/certificate or native capabilities requires a new binary. Bump `runtimeVersion` in `app.config.ts` whenever native dependencies or configuration become incompatible; never reuse a runtime for incompatible builds.

Install a compatible runtime `zorid-5` binary once to use its new native capabilities; subsequent signed JavaScript releases can change their UI, patterns and orchestration. [Build 28](https://github.com/tingkai-c/zorid-mobile/actions/runs/43083842780) compiled, signed and uploaded to TestFlight; its signed OTA release is verified. Apple processing and physical-device testing are recorded separately in [delivery evidence](docs/verification.md#core-haptics-and-common-device-apis).

## Boundaries

- Releases update the whole JavaScript library. Individual independently loaded mini-app bundles are not implemented.
- SQLite records are local to this installation. The backend schema is a foundation, not a running sync service. PowerSync and Yjs remain candidates.
- Focus widgets use the installed SwiftUI renderer. New native components and extension declarations require rebuilding. See [widgets](docs/widgets.md).
- Screen Time selections remain on each device. Deployed code can orchestrate blocklists/allowlists and configure Apple's nine public shield appearance fields. See [Screen Time API and limitations](docs/screen-time.md); usage reports and website filtering are not implemented.
- Downloaded apps can request UIKit feedback and custom Core Haptics transient/continuous patterns, curves and advanced-player controls. The custom engine is haptics-only; audio resources and raw actuator samples are not exposed. See [haptics](docs/haptics.md).
- The [device bridge](docs/device.md) covers authentication, local notifications/actions, clipboard, photo picking/saving, Calendar and Reminders. [Official Expo APIs](docs/device-expo.md) provide files/document previews, foreground location, contacts, audio, sensors, power/network/device status and printing/PDFs. These are supported common capabilities, not all Apple APIs. Check permissions, OS and hardware support, and release subscriptions/resources when unused.
- Downloaded device API calls use the React Native app process; Core Haptics requires the foreground. Widget rendering and durable action handlers have their own narrower APIs. Downloaded interfaces share Zorid's sandbox and OS grants; background location/audio, remote push and general background jobs are not configured by exporting an API.
- iOS suspends JavaScript in the background. Native countdown displays continue, while saved session completion reconciles when the app returns. No APNs activity update service is implemented.
- Typechecking, tests, and export do not establish physical-device behavior. Signing, installation, extension rendering, and real OTA recovery require their own verification.

See [architecture](docs/architecture.md) and [working agreements](AGENTS.md). MIT licensed.
