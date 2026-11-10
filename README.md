# Zorid

An open-source personal workspace for iPhone. Build native-rendered tools in React Native, keep their data on the device, and deliver signed JavaScript releases from your paired laptop over Tailscale.

This foundation includes tasks, a persistent focus timer, work-session history, Settings with host pairing, and Focus widgets/Live Activities. It uses Bun, Expo SDK 58, React Native, and SQLite. PostgreSQL is the future shared-data foundation; cross-device synchronization is **not implemented yet**.

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

See [iOS builds](docs/ios-builds.md) for secrets, signing, installation, and runner requirements. A simulator ZIP cannot install on an iPhone. Distribution profiles must cover the main app, widget extension, App Group, and registered devices.

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
bunx expo config --type public --json > dist/ios/expoConfig.json
bun run host deploy dist/ios --runtime zorid-1
```

Settings checks, downloads, and applies the release. Already cached code and saved tasks work without the host. The phone must be connected to the same tailnet to download. Changing the pinned host/certificate or native capabilities requires a new binary. Bump `runtimeVersion` in `app.config.ts` whenever native dependencies or configuration become incompatible; never reuse a runtime for incompatible builds.

## Boundaries

- Releases update the whole JavaScript library. Individual independently loaded mini-app bundles are not implemented.
- SQLite records are local to this installation. The backend schema is a foundation, not a running sync service. PowerSync and Yjs remain candidates.
- Focus widgets use the installed SwiftUI renderer. New native components and extension declarations require rebuilding. See [widgets](docs/widgets.md).
- iOS suspends JavaScript in the background. Native countdown displays continue, while saved session completion reconciles when the app returns. No APNs activity update service is implemented.
- Typechecking, tests, and export do not establish physical-device behavior. Signing, installation, extension rendering, and real OTA recovery require their own verification.

See [architecture](docs/architecture.md) and [working agreements](AGENTS.md). MIT licensed.
