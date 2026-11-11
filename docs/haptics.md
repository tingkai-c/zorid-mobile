# UIKit haptics for deployed apps

The installed Zorid shell exposes UIKit feedback generators to downloaded React Native application code. These calls run in the app process; the isolated widget-action JavaScript runtime does not expose UIKit. After installing a binary containing this bridge, haptic calls can change through direct deployment without another native build.

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

`prepare('impact', style?)`, `prepare('selection')`, and `prepare('notification')` warm cached generators before an interaction. An omitted impact style uses `medium`. `reset()` releases these cached generators. Calls execute on the native main queue. Prepare ahead of a likely interaction; awaiting this call confirms the request was processed, not that the hardware is already ready. Preparing immediately before feedback does not guarantee reduced latency.

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

## Custom Core Haptics patterns

The separate `coreHaptics` facade exposes Core Haptics engines and advanced pattern players to deployed React Native app code. It runs in the foreground app process. Widget extensions and the isolated action runtime cannot play these patterns.

```ts
import { coreHaptics } from '../native/core-haptics';

const capabilities = await coreHaptics.status();
if (capabilities.available && capabilities.supportsHaptics) {
  const player = await coreHaptics.createPlayer({
    Version: 1,
    Pattern: [{
      Event: {
        Time: 0,
        EventType: 'HapticContinuous',
        EventDuration: 0.5,
        EventParameters: [
          { ParameterID: 'HapticIntensity', ParameterValue: 0.7 },
          { ParameterID: 'HapticSharpness', ParameterValue: 0.4 },
        ],
      },
    }],
  });
  await player.start();
  // Dispose after playback, once this pattern is no longer needed.
  // await player.dispose();
}
```

`createPlayer(ahap)` accepts an Apple AHAP JSON dictionary and returns an opaque native `id`, native pattern `duration` in seconds, and playback methods. Creation starts the engine when needed and loads a player; `player.start()` begins its pattern. Apple's parser validates the pattern. JavaScript validates plain, finite JSON and captures it before crossing the bridge.

The bridge currently accepts `HapticTransient` and `HapticContinuous` events, event parameters, dynamic parameters, and parameter curves. It deliberately uses a haptics-only engine: audio events, audio files, and resource paths reject. `supportsAudio` reports the device's hardware capability, while `audioResources: false` identifies this bridge limitation. This does not expose actuator PCM or guarantee exact physical acceleration or vibration amplitude.

Player methods are:

| Method | Behavior |
| --- | --- |
| `start({ delay? })` | Start playback immediately or schedule against the native engine clock. |
| `stop({ delay? })` | Stop this player's playback. The engine and other players remain separate. |
| `pause({ delay? })` / `resume({ delay? })` | Pause or resume this player. |
| `seek(offset)` | Seek to a pattern offset in seconds. |
| `configure({ loopEnabled?, loopEnd?, playbackRate?, isMuted? })` | Configure the advanced player; omitted properties retain their current native values. |
| `sendParameters([{ id, value }], { delay? })` | Send dynamic parameters to the player. |
| `scheduleCurve(id, [{ time, value }], { delay? })` | Schedule a dynamic parameter curve with times relative to its start. |
| `dispose()` | Cancel and release the native player. |

Delays are seconds in `0…60`, relative to the native engine clock when the command executes. Omitted or zero delay uses Apple's immediate-time constant. Playback scheduling is native; JavaScript is not responsible for timing individual haptic events. Seeking and `loopEnd` must stay within the native pattern duration. `loopEnd: 0` uses the end of the last event. `playbackRate` is an advanced-player rate multiplier and accepts positive values representable as a finite native Float; there is no imposed speed range. Native errors propagate, including invalid player state and values rejected by Core Haptics. The lower-level `coreHaptics.command(playerId, command)` accepts the typed command union used by these methods.

Supported dynamic parameter IDs are `HapticIntensityControl` (`0…1`), and `HapticSharpnessControl`, `HapticAttackTimeControl`, `HapticDecayTimeControl`, `HapticReleaseTimeControl` (`−1…1`). Curves require sorted finite control-point times. These controls modify Core Haptics synthesis; they are not arbitrary raw vibration samples.

`coreHaptics.start()` explicitly starts the engine. `coreHaptics.stop()` and `coreHaptics.reset()` invalidate all loaded player handles; create fresh players afterward. Backgrounding, system interruptions, and engine resets can also invalidate players, with no automatic replay. Use `status()` to inspect the current native engine state, `generation`, `stoppedReason`, `lastError`, and player readback. Player states include `ready`, `scheduled`, `playing`, `paused`, `stopped`, and `finished`. A delayed pause or stop retains the previous state until its scheduled time. `stateBasis: 'commandsAndCallbacks'` identifies these states as projections from accepted commands, the engine clock, and completion callbacks. Each player also reports `lastCommand` and `stateSource` (`command` or `completion`). Core Haptics provides no advanced-player `isPlaying` getter; these fields do not measure physical playback. `generation` changes when handles are invalidated. A resolved playback call confirms the native command was accepted, not that physical feedback was measured or delivered.

Bridge budgets are 16 loaded players, 256 KiB UTF-8 JSON per pattern/command, 1024 pattern entries or curve control points, a 120-second pattern timeline, and at most 30 seconds for one continuous event. Dispose players to release capacity. JavaScript transport snapshots prevent later mutations from changing already-issued patterns or commands. Native code remains authoritative for pattern, state, duration, hardware, and foreground checks.

Older installed binaries and web report `available: false`, unknown hardware capabilities, and an explicit upgrade reason; engine and playback calls reject. A new binary installs the capability once, after which downloaded JavaScript can create and change patterns and playback behavior through direct deployment.
