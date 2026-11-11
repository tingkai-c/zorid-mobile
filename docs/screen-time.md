# Screen Time focus protection

Screen Time is an installed native capability that directly deployed JavaScript can use. Runtime `zorid-4` adds the `ZoridScreenTime` bridge and Device Activity Monitor extension. Existing `zorid-3` installations require a new signed binary before they can use this capability. Changes to the deployed interface, chosen policy and session orchestration can then use the paired host's ordinary JavaScript deployment.

## Device-local selection

Request individual authorization, then present Apple's native `FamilyActivityPicker`. Policies have a stable app-scoped identifier, mode and device-local opaque selection. JavaScript receives only counts and identifiers, never application tokens, app names or a list of installed apps. Selection and authorization cannot be supplied by a remote deployment. Each device chooses its own apps.

- `blocklist`: restrict selected apps and categories. An empty list is rejected.
- `allowlist`: restrict app categories except selected individual apps. Up to 50 individual app exceptions are supported. Zorid itself remains accessible. This does not promise a complete device lockdown, and other Screen Time restrictions can still apply.
- Website filtering and usage reports are outside this implementation.
- Revoking authorization invalidates selections. Reauthorize and choose apps again.

References: [individual authorization](https://developer.apple.com/videos/play/wwdc2022/110336/), [native picker](https://developer.apple.com/documentation/familycontrols/familyactivitypicker), [allowlist policy](https://developer.apple.com/documentation/managedsettings/shieldsettings/activitycategorypolicy/all(except:)).

## Deployed JavaScript interface

```ts
import { screenTime } from '../screen-time';

const appId = 'productivity';
await screenTime.requestAuthorization(appId);
await screenTime.editPolicy(appId, 'focus', 'blocklist'); // native picker
await screenTime.apply(appId, {
  policyId: 'focus', sessionId: 'session-123', endsAt: Date.now() + 25 * 60_000,
});
const status = await screenTime.status(appId);
await screenTime.clear(appId);
```

`editPolicy` saves only after the person confirms; cancel retains the saved selection. Editing a currently applied policy is rejected. `status` reports authorization, policy counts and the native active session. A missing bridge reports unavailability rather than simulating enforcement. Direct commands require app/policy/session identifiers of at most 64 characters and positive integer deadlines no more than 24 hours ahead.

For actions that mutate durable records, use the action bundle's `screenTime` capability and synchronous SDK instead of mixing direct calls with queued commands:

```ts
function startSession(args, sdk) {
  if (!sdk.screenTime) throw new Error('This binary cannot block apps.');
  sdk.records.put('sessions', args.id, args.session);
  sdk.screenTime.apply({
    policyId: 'focus', sessionId: args.id, endsAt: args.endsAt,
  });
}
```

This queues a validated native effect in the same transaction as records and the invocation receipt. Restrictions apply after commit and independently of widget/Live Activity rendering. A failed application is surfaced and remains retryable; a saved timer does not establish successful blocking. Later clear effects supersede earlier activation effects for the same app. The bridge is for trusted signed code, not a sandbox for untrusted applications.

## Focus integration and expiry

The Focus page stores the selected policy ID in the shared `state/focus-screen-time` document. Start, pause, resume and finish publish the appropriate native command. Running sessions apply the selected policy; pause, completion and disabling protection clear Zorid's restrictions. Disabling persists a newer clear before the direct native release. If that persistence fails, emergency release also invalidates the selected native policy so a pending old activation cannot reapply it; the app list must then be selected again.

The native controller persists a deadline and schedules a nonrepeating `DeviceActivityMonitor` interval before applying shields. Scheduling failure clears restrictions. A generation-specific monitor name prevents an obsolete callback from clearing a replacement session. Expired queued commands do not re-block apps. Foreground native status reconciliation also clears expired sessions.

Apple documents a [15-minute minimum monitoring interval](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/monitoringerror/intervaltooshort). Short remaining sessions use an ongoing interval whose start is backdated to satisfy that minimum. The API supports starting monitoring during an ongoing interval, but this particular short-session strategy still requires physical-device acceptance. [Interval-end callbacks](https://developer.apple.com/documentation/deviceactivity/deviceactivitymonitor/intervaldidend(for:)) occur when the device is in use. There is no second-precise background callback or background JavaScript guarantee.

## Signing and delivery

The app, widget extension (which executes native button actions), and monitor need Family Controls distribution approval and compatible profiles:

- `app.zorid.mobile`
- `app.zorid.mobile.widgets`
- `app.zorid.mobile.focus-monitor`

All three share `group.app.zorid.mobile`. [Apple requires the account holder to request distribution access](https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement), including for participating extensions, before TestFlight distribution. Development capability alone is insufficient.

Run `gh workflow run screen-time-access.yml` to inspect existing runner-only TestFlight profiles. Its downloadable receipt contains only capability flags. Missing flags establish that the current profiles need replacement; they do not prove whether Apple has already approved the capability in the portal. Signing preparation rejects missing capabilities before a signed build is attempted.

The existing profile check (run `43068058169`) found no Family Controls entitlement in the app/widget profiles and no monitor profile. A simulator artifact can verify compilation while account approval and regenerated signing profiles remain pending. Authorization, shielding, background expiry, pause/resume and actual picker appearance require a signed physical-device check.
