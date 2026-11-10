# Web preview

The web target is a development preview of the native app. It does not provide native widgets, Live Activities, secure host pairing, or native OTA installation. A desktop application is outside this foundation.

`bun run export:web` writes the preview to `dist/web`. Metro now includes `.wasm` assets so Expo SQLite's worker can load its bundled SQLite runtime.

SQLite on web also requires cross-origin isolation for `SharedArrayBuffer`. Serve the preview from localhost or HTTPS with these response headers:

```http
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Opener-Policy: same-origin
```

The Expo Router plugin config includes these headers for compatible hosting. Metro's middleware also adds them to requests it handles. In the installed Expo SDK 58 CLI, `expo start --web` serves the single-page HTML before the Metro middleware, so that document does **not** receive these headers. Do not assume the default development URL supports SQLite just because it bundles successfully.

For a local exported preview without additional dependencies, run this from the repository root:

```sh
bun run export:web
bun scripts/preview-web.ts
```

The preview server binds only to localhost, serves known app routes through `index.html`, checks paths against the export directory, and sends the required headers and wasm MIME type. It is a development utility, not a production hosting server.

Open `http://127.0.0.1:8100`. For a remote browser, use an SSH tunnel to WSL's port 8100 and open the forwarded localhost URL; plain HTTP on a remote IP is not a secure context. Browser data belongs to that browser origin. Changing host or port changes its storage, and clearing browser data may remove local records.

Validation: web export succeeded and included the SQLite wasm asset and worker bundle. The exported preview server's HTTP checks verified root/task routes, isolation headers, wasm MIME, missing-file 404s, and encoded traversal rejection. Browser automation was unavailable in this workspace, so page rendering, task persistence across reloads, and browser SQLite operation remain unvalidated. A manual smoke check should confirm `crossOriginIsolated === true`, create a task, reload, and verify the task persists. Native iOS remains the primary runtime.

Reference: [Expo SDK 58 SQLite web setup](https://docs.expo.dev/versions/v58.0.0/sdk/sqlite/#web-setup).
