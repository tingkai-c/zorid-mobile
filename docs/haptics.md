# UIKit haptics for deployed apps

The installed Zorid shell exposes UIKit feedback generators to downloaded JavaScript. After installing a binary containing this bridge, haptic calls can change through direct deployment without another native build.

```ts
import { haptics } from '../native/haptics';

if (haptics.available) {
  await haptics.prepare('impact', 'heavy');
  await haptics.impact('heavy', { intensity: 0.8 });
  await haptics.selection();
  await haptics.notification('success');
}
```

`impact` supports `light`, `medium`, `heavy`, `soft`, and `rigid`. Its optional `intensity` must be finite and between 0 and 1; omitting it uses UIKit's default for the selected style. `notification` supports `success`, `warning`, and `error`. `selection` signals a change in selection.

`prepare('impact', style?)`, `prepare('selection')`, and `prepare('notification')` warm cached generators before an interaction. An omitted impact style uses `medium`. `reset()` releases these cached generators. Calls execute on the native main queue; await preparation when the following interaction depends on it being ready.

`await haptics.status()` returns `{ available, location, supportsHaptics }`. `available` describes bridge availability. `supportsHaptics` is the hardware capability reported by Core Haptics, or `null` when the bridge is absent. Hardware capability is advisory and does not prevent a call. UIKit, device hardware, and system settings determine physical feedback; promise resolution confirms native processing and does not confirm a vibration occurred. Style and intensity do not provide control over exact amplitude or waveforms.

On iOS 17.5 and later, a location can be supplied to all three feedback methods:

```ts
if ((await haptics.status()).location) {
  await haptics.impact('soft', { intensity: 0.5, at: { x: 120, y: 240 } });
  await haptics.selection({ at: { x: 120, y: 240 } });
  await haptics.notification('warning', { at: { x: 120, y: 240 } });
}
```

Coordinates are finite logical points relative to the current presented foreground native view. Negative and outside-view coordinates are accepted; these are neither normalized coordinates nor physical pixels. A location call rejects when the OS lacks support or a foreground view is unavailable. Values are captured before crossing the bridge.

Web and older binaries return `available: false` with an upgrade reason. Feedback calls reject with a clear message instead of simulating success. Preparation and reset also detect their own optional native methods. Unknown options, invalid styles, nonfinite coordinates, and out-of-range intensity are rejected before native execution. This API exposes UIKit feedback generators; it does not expose custom Core Haptics patterns.
