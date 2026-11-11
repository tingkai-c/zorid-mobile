# Downloaded-app routes and Home Screen actions

The installed shell owns URL delivery and the reserved Zorid Settings Home Screen action. Downloaded code supplies its own destinations and the three dynamic menu items. Changes to those labels, SF Symbols, and destinations can arrive in an OTA release after installing the binary with this bridge.

## Register a menu and destinations

```ts
import { appURL } from '../shell/routes';
import { registerAppRoutes } from '../shell/routes-client';
import { setQuickActions } from '../shell/shortcuts';

await setQuickActions('productivity', [
  { id: 'focus', title: 'Open Focus', systemImage: 'timer',
    url: appURL('productivity', ['focus']) },
  { id: 'tasks', title: 'Tasks', systemImage: 'checklist',
    url: appURL('productivity', ['tasks']) },
]);

// Mount after the downloaded app can navigate. Unregister when it unloads.
const unregister = registerAppRoutes('productivity', route => {
  if (route.path[0] === 'focus') router.replace('/focus');
  else if (route.path[0] === 'tasks') router.replace('/tasks');
});
```

`setQuickActions(appId, items)` replaces the active downloaded app's dynamic menu; it returns `false` when the native bridge is unavailable. An empty list removes the dynamic menu. The Settings item remains a static installed action and is prioritized by iOS. The limit of three dynamic items is a Zorid product choice, leaving four total; Apple's display limit is system-defined. There is currently one global menu, rather than an automatically merged menu across independent apps.

The native shell saves validated quick-action definitions and restores them without running downloaded JavaScript. Every dynamic item shares an installed native type, with app/item IDs resolved against the saved definition when selected. A newly deployed app can change the menu without adding native types.

## URL contract

Use `zorid://apps/<appId>/<path>?<query>`. For example:

- `zorid://apps/productivity/focus`
- `zorid://apps/productivity/tasks?filter=today`
- `zorid://apps/notes/record/abc123`

`appURL(appId, path, query)` encodes each segment and validates the result. App IDs are lowercase letters/numbers followed by letters/numbers, dots, underscores or hyphens (maximum 64 characters). Native and JS validation reject unrelated schemes/hosts, credentials, ports, fragments, duplicate query keys, dot traversal, encoded path separators, malformed escapes, control characters, and excessive input sizes. Existing `zorid://pair` and `zorid://focus` links remain outside this dispatcher and continue through Expo's linking lifecycle.

`registerAppRoutes(appId, handler, onError?)` receives `{ id, appId, path, query, url, source, receivedAt }`. `source` is `link` or `quickAction`, set by the installed shell. A URL query or fragment cannot choose this source. The quick-action entry point resolves its IDs against the saved native menu definition rather than trusting an incoming URL in the shortcut metadata. Routes navigate; the SDK never automatically runs an action named in a URL. Apps must explicitly authorize any mutation they decide to expose through incoming links. Custom URL schemes are externally invocable and do not authenticate the sender.

## Launch and acknowledgment

Scene hooks record incoming custom app URLs on both cold and warm launches. Cold startup retains Expo forwarding; warm delivery forwards only URLs outside the app-route dispatcher, preventing a second Router navigation from replacing the selected destination. Home Screen actions use the same persistent native queue. Register a handler once the app's navigation is ready. The client reads pending destinations, awaits each matching handler, then acknowledges it. Missing apps and failed handlers leave routes pending for a later registration or `retryAppRoutes()` call. Foreground activation also retries pending routes. An acknowledgment failure is retried without repeating a successful handler within that JS runtime; after a process crash, navigation may repeat. Do not implement irreversible mutations in a navigation handler.

The queue retains the latest 32 destinations; if no app handles links for an extended period, older entries are evicted. UserDefaults persistence covers normal app/OTA restarts, not a guarantee against sudden power loss. Route metadata stays on the phone and does not enter the delivery host.

Expo Router applications should use `+native-intent.tsx` to redirect the `zorid://apps/...` transport URLs to a valid shell route while this dispatcher delivers the actual destination. Otherwise Router may render its unmatched-route screen before registration.

## HTTPS links

This implementation uses the installed `zorid` scheme. Universal links need a chosen HTTPS domain, an `apple-app-site-association` file served by that domain, and Associated Domains entitlements in a new binary. After the domain is associated, downloaded app routing can evolve beneath that existing domain without another native build. No associated domain is configured or deployed by this change.

## Verification

Bun tests cover route/shortcut validation, native envelope decoding, reserved IDs and generated cold/warm lifecycle hooks. The native parser and queue can also run in a standalone Swift check on the macOS CI runner; actual iPhone Home Screen menu and cold/warm navigation require device acceptance.

Sources checked against installed Expo SDK 58:

- [Apple: Home Screen quick actions](https://developer.apple.com/documentation/uikit/add-home-screen-quick-actions)
- [Apple: dynamic shortcut items and system ordering](https://developer.apple.com/documentation/uikit/uiapplication/shortcutitems)
- Installed `node_modules/expo/ios/Expo/ExpoAppSceneDelegate.swift` forwards scene URL delivery to Expo/React Native.
