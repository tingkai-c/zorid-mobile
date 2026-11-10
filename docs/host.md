# Paired laptop update host

Zorid ships whole-library React Native JavaScript releases from the user's host. Bun runs the local CLI/service; Tailscale Serve provides HTTPS. No EAS account or hosted update service is involved. The installed app pins the host update URL, runtime version, and public signing certificate. Changing those trust settings requires a new binary. Pairing grants code-download access only; it does not grant access to personal records or provide data synchronization.

## Initialize and serve

```sh
bun host/cli.ts init --url https://YOUR-HOST.YOUR-TAILNET.ts.net:10000
bun host/cli.ts serve --port 8787
# In another terminal, configure the available port on your host:
tailscale serve --bg --https=10000 http://127.0.0.1:8787
bun host/cli.ts pair
```

The default private state directory is `~/.local/share/zorid`. Override it with `ZORID_HOME` or `--state`. It contains the SQLite registry, content-addressed assets, RSA private key, and public certificate. The directory is mode 0700 and private files mode 0600. Keep it out of Git, shared folders, build artifacts, and public logs. Back it up privately: losing the signing key requires rebuilding the installed binary with a new trust certificate.

The native update configuration must declare `requestHeaders.Authorization` before `setUpdateRequestHeadersOverride` can set a paired credential. Zorid embeds the nonsecret, unauthorized placeholder `Bearer unpaired`; the actual bearer stays in SecureStore. Expo restricts overrides to embedded header keys ([official documentation](https://docs.expo.dev/eas-update/channel-surfing/)). Device build 10 omitted that declaration: the host could redeem the offer, but the app then reported failure when applying update headers. Install a corrected binary over that version to retain local data and the saved credential. JavaScript OTA cannot repair the old binary's header allowlist.

`init` outputs the **public** certificate path. Set `ZORID_UPDATE_URL` to the origin plus `/updates` and `ZORID_UPDATE_CERTIFICATE` to this public certificate for native builds. The matching Expo code-signing metadata is `{ "keyid": "main", "alg": "rsa-v1_5-sha256" }`. The host itself listens only on loopback. HTTPS termination is handled by Tailscale Serve. `init --dev-loopback --url http://127.0.0.1:8787` exists for local service development; an iPhone cannot use the host's loopback address.

Runtime `zorid-2` uses native setup/settings rather than a permanent app tab. First pairing attempts to download and launch the first compatible release. Publish that runtime before pairing. Later launches open cached code directly; use the three-finger hold or Home Screen **Zorid Settings** shortcut for update controls.

## Pairing contract

`pair` prints a terminal QR code and a `zorid://pair?url=<encoded-origin>&token=<token>` URI. Treat both as credentials until consumed or expired. `--json` omits the terminal QR and emits JSON for agents. Offers use 256-bit random tokens, expire after five minutes, and can be redeemed once. Creating an offer does not revoke existing devices.

The phone must first compare the QR origin against its binary-pinned update origin. It then sends:

```http
POST /pair
Content-Type: application/json

{"token":"<offer-token>","deviceName":"My iPhone"}
```

The response is `{ deviceId, token, hostName, updateUrl }`. Store the device token in SecureStore; configure the updater with `Authorization: Bearer <token>`. The host stores only SHA-256 hashes of offer/device tokens. Pairing redemption is atomic across CLI and service processes through SQLite. Revocation takes effect for subsequent requests immediately.

```sh
bun host/cli.ts devices --json
bun host/cli.ts revoke DEVICE-ID --json
bun host/cli.ts status --json
```

The local `status` command lists release IDs and registered device names. Authenticated HTTP `GET /status` returns only `{ hostName, connected: true }`. There is no HTTP deployment or administrator endpoint; deploy commands require local access to the private host state directory.

## Publish and restore releases

```sh
bun run export:ios
bun host/cli.ts deploy dist/ios --runtime EXACT-INSTALLED-RUNTIME --json
bun host/cli.ts rollback PREVIOUS-RELEASE-ID --json
```

The export must contain Expo `metadata.json` with `fileMetadata.ios.bundle` and `fileMetadata.ios.assets`. Android exports can be selected with `--platform android`. An optional `expoConfig.json` is placed into manifest `extra.expoClient`; include only configuration intended for clients. Deployment rejects absolute paths and references/symlinks escaping the export directory. Each asset is copied to immutable SHA-256-addressed private storage before its release becomes visible. Explicit runtime matching is required; the host cannot determine whether you mislabeled a release with incompatible native dependencies.

`GET /updates` requires a device bearer token and Expo platform/runtime headers. It returns protocol v1 multipart manifests, RSA-SHA256 signatures, and per-asset Authorization headers through the protocol's `extensions.assetRequestHeaders` mechanism. Assets also require device authentication; credentials are not placed in asset URLs. Unknown runtimes and already-current releases receive HTTP 204. Clients must accept `multipart/mixed` because authenticated asset request headers need its extensions part.

`rollback` republishes the chosen release's immutable assets under a new update UUID and later creation time for that release's runtime/platform. This is a **forward publication of previous code**, not a data rollback or an immediate interruption of running devices. The phone must fetch and launch it. Expo's local cache and launch recovery remain responsible for offline starts and failed-update recovery; runtime and signature checks are enforced by the native updater. Updates are whole-library and require foreground network opportunity. iOS does not permit an ordinary host to wake an arbitrary suspended app for immediate code installation.

## Validation and current boundaries

Run `bun test host` for pairing expiry/replay, device revocation, authorization, signature verification, runtime isolation, immutable assets, rollback ordering, and path containment checks. Native download/apply, authenticated asset header forwarding, first launch offline, and crash recovery must also be exercised on a signed physical-device build. Passing the host tests alone does not establish that device integration works.

The service is intended for one trusted user's tailnet. It has no account system, internet-facing administration, arbitrary feature bundle loader, data sync, certificate rotation UI, storage garbage collection, or remote push notifications. A revoked phone retains code it already downloaded. Preserve native API compatibility and local-data readability across releases and rollbacks.

Protocol references: [Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/) and [Expo's custom update server example](https://github.com/expo/custom-expo-updates-server). Implementation follows the installed Expo SDK's native update client; Expo supplies the client protocol, not hosting.
