# Official native APIs for deployed apps

`src/device/expo.ts` exposes the official modules included in the runtime `zorid-5` source configuration. They provide their complete SDK 58 JavaScript interfaces and types; Zorid does not maintain duplicate wrappers for each operation. Native installation, OS support, authorization, and hardware availability remain separate requirements. Source integration and typechecking do not establish that a particular signed build has shipped or that an operation passed physical-device testing.

The entry exports these namespaces:

| Namespace | Installed module and purpose |
| --- | --- |
| `FileSystem` | `expo-file-system`: sandbox files/directories, document import, transfers, file handles and native previews. |
| `Location` | `expo-location`: foreground location, heading and geocoding. |
| `Contacts` | `expo-contacts`: current `Contact`, `Group`, `Container` APIs and authorization. |
| `Audio` | `expo-audio`: players, playlists, recording and audio-session configuration. |
| `Sensors` | `expo-sensors`: accelerometer, gyroscope, motion, barometer, magnetometers and pedometer where supported. |
| `Battery`, `Network`, `Device` | Official battery/power, network-state and device-information modules. |
| `Print` | `expo-print`: system printing and HTML-to-PDF generation. |
| `Camera`, `SecureStore`, `ExpoLinking`, `Crypto`, `Constants` | Existing Camera, Keychain storage, app links, cryptography and runtime constants. |

It also exports React Native `Share`, `Linking`, `AppState`, `Appearance`, `AccessibilityInfo`, `Dimensions`, `Keyboard`, `PixelRatio`, `Platform` and `Vibration`. Use `Share.share` for text/URLs and `Linking.openURL` for supported links. Those APIs do not establish unrestricted file sharing, new incoming URL registrations or arbitrary private Settings access.

## Import after compatibility checks

The Expo entry is intentionally separate from `src/device/index.ts`. Several official modules require a native module during import; importing them in an older binary can throw before an availability check runs. Use a runtime-compatible release, or dynamically load the entry after checking the optional device bridge:

```ts
import { device } from '../src/device';

export async function chooseDocument() {
  if (!device.available) throw new Error('Install a Zorid runtime zorid-5 build first.');
  const { FileSystem } = await import('../src/device/expo');
  const picked = await FileSystem.File.pickFileAsync({ multipleFiles: false });
  if (picked.canceled) return null;
  return picked.result;
}
```

`device.available` detects the companion native bridge, not permission grants or every Expo module's hardware availability. Runtime release compatibility prevents the bundle from being offered to binaries that lack its native modules. Direct imports are appropriate for code that already requires runtime `zorid-5`. Neither entry requests permission, starts recording, subscribes to sensors or queries personal records at import. Call those operations from a relevant user interaction.

## Files and PDFs

SDK 58's current picker returns `{ canceled, result }`; `result` is a `File` or `null`. On iOS, retain an imported file by copying it into an app-owned document directory. Use `await file.copy(destination)` and `await file.canPreview()` before `await file.preview()` for Quick Look. Preview resolution confirms presentation, not viewer dismissal. Directory picker access on iOS lasts only for that app session. Do not treat a saved external directory URI as permanent permission. See [SDK 58 FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/).

`Print.printToFileAsync({ html })` produces a PDF in cache; copy it into documents for persistence. Inline local images as base64 when building HTML for iOS printing, and escape untrusted note text before interpolating it into HTML. Native print UI and PDF preview are separate operations. See [SDK 58 Print](https://docs.expo.dev/versions/v58.0.0/sdk/print/).

## Location and contacts

Use `Location.getForegroundPermissionsAsync()` and, when appropriate, `requestForegroundPermissionsAsync()`. They map to When In Use on iOS. Preserve the complete response, including reduced accuracy and scope; Allow Once may expire when the app session ends. The examples request a balanced one-shot position and never ask for Always access. Location streams must be removed when no longer needed. This build does not configure background location tasks or promise background geofencing. See [SDK 58 Location](https://docs.expo.dev/versions/v58.0.0/sdk/location/).

Use the current `Contacts.Contact` class. `Contact.presentPicker()` handles contact selection, `Contact.getAllDetails(fields, { limit, offset })` supports bounded field-specific queries, and `Contact.presentAccessPicker()` lets iOS 18+ users expand a limited selection. Keep the full permission response with `accessPrivileges: 'all' | 'limited' | 'none'`; limited access is a valid result. Root legacy names such as `Contacts.getContactsAsync` are throwing migration stubs in this version. Importing `expo-contacts/legacy` explicitly is a different API choice, not required for the examples. Contact notes need a separate restricted entitlement and are not requested here. See [SDK 58 Contacts](https://docs.expo.dev/versions/v58.0.0/sdk/contacts/).

## Audio and sensors

The binary configuration disables background audio playback and recording. Foreground playback examples explicitly use `shouldPlayInBackground: false`, `allowsBackgroundRecording: false`, and `allowsRecording: false`. Ordinary playback needs no microphone permission; recording requires it. Prefer `useAudioPlayer` inside React components; an imperative `createAudioPlayer` requires cleanup. The example pauses and removes the player on app inactivity and exposes a `dispose` function. Audio mode belongs to the shared installed app, so modules must coordinate changes. See [SDK 58 Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/).

Check each sensor's availability and authorization, choose an appropriate sample interval, and remove only the subscriptions your screen created. Sensor interval changes affect the shared native sensor instance; `removeAllListeners` could disrupt another screen. The example unsubscribes on app inactivity and exposes `dispose` for unmount. Sensors do not provide perpetual background JavaScript execution; supported hardware differs, and the light sensor is Android-only. See [SDK 58 Sensors](https://docs.expo.dev/versions/v58.0.0/sdk/sensors/).

## Power and connectivity

Return unknown values faithfully: battery level can be `-1`, battery state can be `UNKNOWN`, and network fields can be absent. A connected network does not prove a paired laptop or internet service is reachable. On iOS Expo's `isInternetReachable` equals `isConnected`; attempt the actual request and handle failure. The examples do not query IP addresses, SSIDs or device identifiers. See [SDK 58 Battery](https://docs.expo.dev/versions/v58.0.0/sdk/battery/), [Network](https://docs.expo.dev/versions/v58.0.0/sdk/network/), and [Device](https://docs.expo.dev/versions/v58.0.0/sdk/device/).

## Executable examples and boundaries

[examples/native-capabilities.ts](../examples/native-capabilities.ts) contains typechecked, opt-in functions for file import/copy/preview, When In Use location, contact selection and limited access, foreground audio, sensor cleanup, power/network observations, and PDF retention/preview. Importing that file does not invoke them. Wire these functions to your own UI and call returned `dispose` functions on unmount. The sample folders use `apps/native-capabilities`; choose a stable per-app namespace in real tools.

The complete official namespace exports include APIs that require configuration not enabled in this build, such as background location/audio. An exported function does not add its entitlements or execution context. All these APIs run in the React Native application process, not the widget renderer or isolated durable-action runtime. Downloaded apps share one app sandbox and OS permission identity. Additional native dependencies or permission/entitlement configuration still require a new installed binary. See [device bridge](device.md), [capability catalog](apple-capabilities.md), and [haptics](haptics.md) for the companion custom bridges and remaining coverage.
