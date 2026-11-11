# Native action surface adapter

`plugins/with-zorid-actions.cjs` runs after Expo Widgets during prebuild. It patches the reviewed Expo Widgets 58.0.27 native sources and adds the local `ZoridActions` pod dependency. An unreviewed package version, changed anchor or damaged generated patch fails prebuild. The tracked adapter source is `native/actions/ZoridActionSurfaces.swift`; changes to generated native files or `node_modules` are not the source of truth.

## Dispatch and recovery

A widget or Live Activity button can use a target of `zorid-action:` followed by unpadded base64url-encoded UTF-8 JSON:

```json
{
  "appId": "productivity",
  "actionId": "pause",
  "invocationId": "a-stable-unique-id-for-this-rendered-operation",
  "bundleVersion": "1",
  "args": {"sessionId": "session-id"}
}
```

The adapter intercepts only this prefix, before Expo's isolated `onPress` callback. Use `zorid-activity-action:` with the same payload for an action explicitly intended to update a Live Activity. For that prefix only, the widget button uses the existing `LiveActivityUserInteraction` intent so iOS executes it in the app process. This does not require a running React interface. Normal Expo interactions retain their existing behavior. Widget intents retain `AppIntent`; Live Activity intents retain `LiveActivityIntent`. Native action validation, idempotency and record transactions live in `ZoridActionRuntime`, independently of this adapter and the React interface.

Following a committed action, the adapter reads pending effects and applies them in sequence order. A successful surface update gets a persisted sequence checkpoint before acknowledgement. Checkpoints prevent an older deferred effect from replacing a newer surface update. A nonblocking App Group file lock coordinates flushes between app and extension processes; contention returns a retryable error instead of waiting indefinitely. A failed or interrupted flush retains unacknowledged effects. A failed activity update does not block the widget portion or any later effect: each surface is attempted independently, then unresolved failures are reported after processing. A newer successful checkpoint supersedes older failed work for that surface. Each flush handles at most four batches of eight effects, paginating past failed rows. A persisted per-app continuation cursor ensures more than 32 failures cannot permanently starve a newer update; remaining work returns an explicit pending-update error for a later retry.

`ExpoWidgets.flushZoridActionEffects(appId)` retries pending updates and returns the number acknowledged. Call it after app-dispatched actions and when the app becomes active. The adapter also emits the existing Expo Widgets interaction event with `source: "ZoridActions"` and `target: appId`, so an already-running app can reload its records. That event is a convenience, not durable delivery.

## Effects

Each persisted effect has an `id`, `appId` and monotonically increasing `sequence`, plus the following data:

```ts
{
  widget?: string;
  activity?: string;
  props: Record<string, unknown>;
  timeline?: { date: number; props: Record<string, unknown> }[];
  staleAt?: number;
  endActivity?: boolean;
  startActivity?: boolean;
  url?: string;
}
```

Dates are Unix epoch milliseconds. Widget effects require an existing native widget kind with an available layout. Their timeline entries are converted to Expo's `timestamp` storage format. The adapter validates property-list compatibility before calling UserDefaults; JSON null is not a supported widget prop value in this storage backend. Live Activity effects update or end existing instances matching the named activity. An explicit `startActivity: true` additionally requests a new instance when none is active. This request runs only in the app process and may be rejected while the app is backgrounded; rejected effects stay pending for a foreground retry. Widget control handlers do not request starts. The optional activity `url` must be a `zorid://` deep link with a host and no embedded credentials, at most 2048 UTF-8 bytes. Content is checked against ActivityKit's 4 KiB payload limit.

All focus publication, including app foreground publication, passes through the action store and this adapter rather than writing Expo surface state directly. Handlers read current database records inside their transaction so a stale React snapshot cannot overwrite a newer native widget action. ActivityKit mutations are deferred while executing inside the widget extension. The widget portion can still update immediately, with the remaining activity effect preserved for an app-process flush. Live Activity button intents execute in the app process. This process distinction is documented by [Apple's widget interactivity guide](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities). An app can update a Live Activity while foregrounded or backgrounded, subject to system execution opportunities; see [Activity.update](https://developer.apple.com/documentation/activitykit/activity/update(_:)). A generic `zorid-action:` widget action that unexpectedly changes an activity may therefore need the app to open before that activity's display catches up. Declare the explicit `zorid-activity-action:` execution mode for actions that are known to mutate an activity; the focus demo uses that mode.

Native compilation verifies API integration; physical-device acceptance must still verify cold execution, locked-device behavior, widget timeline refresh and Live Activity buttons. No background scheduling or exact refresh timing is promised.

`native/actions/ZoridSurfaceEffectQueue.swift` contains the platform-independent traversal and checkpoint rules. `scripts/ios/test-surface-effects.swift` exercises real failure/recovery ordering through injected native callbacks on the GitHub macOS runner.

Widget publication follows Expo's `UserDefaults.set` then `WidgetCenter.reloadTimelines` order. It does not gate reload on the legacy `synchronize()` return value; [Apple says this method is unnecessary and should not be used](https://developer.apple.com/documentation/foundation/userdefaults/synchronize()). `scripts/ios/test-widget-storage.py` extracts the actual native method and verifies accepted writes with a false legacy synchronization result, plus distinct missing-defaults and missing-layout failures. This reproduces the false-error path, rather than claiming to prove which storage branch ran on a particular phone.
