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

### Custom blocking screen

Deployed JavaScript can configure every public iOS `ShieldConfiguration` field exposed by the installed renderer. The configuration stays in the shared native container and contains no application tokens. Check `screenTime.shieldAvailable` before configuring appearance on a binary that predates this bridge method.

```ts
const current = await screenTime.status(appId);
await screenTime.configureShield(appId, 'focus', {
  backgroundBlurStyle: 'systemMaterial',
  backgroundColor: { light: '#F7F6F2EE', dark: '#172320EE' },
  icon: { systemName: 'timer' },
  title: { text: 'Focus in progress', color: { light: '#203D38', dark: '#EBF3ED' } },
  subtitle: { text: 'Pause or finish your session in Zorid to use this app.', color: '#65756F' },
  primaryButtonLabel: { text: 'Return to focus', color: '#FFFFFF' },
  primaryButtonBackgroundColor: '#176B58',
  ...(current.shieldCapabilities?.openApp
    ? { secondaryButtonLabel: { text: 'Open Zorid', color: '#176B58' } }
    : {}),
  actions: { primary: 'close', ...(current.shieldCapabilities?.openApp ? { secondary: 'openApp' as const } : {}) },
});
// Restore the installed default appearance for this policy:
await screenTime.configureShield(appId, 'focus', null);
```

`await screenTime.getShield(appId, 'focus')` loads the current public configuration for an editor, or `null` when the existing policy uses the installed default. A missing policy fails explicitly. `status.policies[].customShield` reports whether a custom configuration is present. These reads expose no application tokens.

The nine Apple configuration fields are independent, optional, and nullable. Omission or `null` passes no value for that native field; `{}` accepts Apple's native defaults. Labels are `{ text, color }`; empty strings, whitespace and newlines are preserved without per-field character limits.

| Field | Accepted value |
| --- | --- |
| `backgroundBlurStyle` | Any of the 20 iOS blur styles exported as `screenTimeBlurStyles`. |
| `backgroundColor` | Hex RGB/RGBA, or a dynamic light/dark color. |
| `icon` | `{ systemName: 'timer' }` or `{ pngBase64: '…' }`. |
| `title`, `subtitle` | `{ text: string, color }`. |
| `primaryButtonLabel`, `secondaryButtonLabel` | `{ text: string, color }`. |
| `primaryButtonBackgroundColor` | Hex RGB/RGBA, or a dynamic light/dark color. |
| `secondaryButtonSubmenuItems` | One to three strings, on iOS 26.4 or later. |

Colors support `#RRGGBB`, `#RRGGBBAA`, or `{ light: hex, dark: hex }`. PNG icons are limited to 128 KiB decoded and 1024 × 1024 pixels. The complete JSON configuration has a 256 KiB UTF-8 transport budget; these image and transport bounds protect the extension's resources. Native decoding validates the image. Unknown fields, arbitrary view trees and executable code are rejected. The client captures nested configuration before queuing the native call, so later caller mutations do not alter the request.

`actions` is a separate optional mapping for `primary`, `secondary`, and indexed `submenu` responses. Its default is primary `close`, secondary `none`; `actions: null` restores those defaults. Menu appearance and action bindings are independent: omitted `actions.submenu` defaults each displayed item to `none`. If submenu responses are supplied, a menu must exist and its item count must match. Menu items do not require a nonnull secondary label:

```ts
if (current.shieldCapabilities?.secondarySubmenu) {
  await screenTime.configureShield(appId, 'focus', {
    secondaryButtonSubmenuItems: ['Close this app', 'Refresh this screen', 'Keep showing'],
    actions: { submenu: ['close', 'defer', 'none'] },
  });
}
```

| Response | Result |
| --- | --- |
| `close` | Close the blocked app; its restriction remains in place. |
| `none` or `stay` | Leave the shielding screen and restriction in place. |
| `defer` | Request that iOS redraw the shield; this does not remove the restriction. |
| `openApp` | Open Zorid through Apple's native response, on iOS 26.5 or later. |

`status.shieldCapabilities.openApp` and `.secondarySubmenu` report installed OS support. Configuring an unavailable feature fails explicitly. Buttons do not execute downloaded JavaScript, navigate to an arbitrary app, or implicitly remove restrictions. Apple controls the shield's layout: this bridge exposes its public content, images, blur, colors, menu and response choices rather than accepting arbitrary SwiftUI screens. See [Apple's shield configuration](https://developer.apple.com/documentation/managedsettingsui/shieldconfiguration), [shield responses](https://developer.apple.com/documentation/managedsettings/shieldactionresponse), and [open-parental-controls-app response](https://developer.apple.com/documentation/managedsettings/shieldactionresponse/openparentalcontrolsapp).

Apple does not identify the responsible settings store in shield callbacks, and configuration/action callbacks supply different application/category context. With one active Zorid policy, both callbacks use its custom shield. Multiple active policies can share a custom shield when their complete configurations are identical. If their configurations differ, both callbacks use Apple's default appearance and default responses (`close` for primary, `none` for secondary). Blocking selections and active sessions continue unchanged. This conservative fallback avoids displaying one policy's button and executing another policy's response.

The Focus demo checks current native metadata when app blocking is explicitly enabled and saves a readable focus-themed shield only when the policy has no custom configuration. Existing developer styling is preserved. The default adds the Open Zorid button only when the native capability is reported. After installing the binary containing the shield extensions, these configuration choices can change through ordinary JavaScript deployment.

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

The app, widget extension (which executes native button actions), monitor and both shield extensions need Family Controls distribution approval and compatible profiles:

- `app.zorid.mobile`
- `app.zorid.mobile.widgets`
- `app.zorid.mobile.focus-monitor`
- `app.zorid.mobile.shield-configuration`
- `app.zorid.mobile.shield-action`

All five share `group.app.zorid.mobile`. [Apple requires the account holder to request distribution access](https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement), including for participating extensions, before TestFlight distribution. Development capability alone is insufficient.

Run `gh workflow run screen-time-access.yml` to inspect existing runner-only TestFlight profiles. Its downloadable receipt contains only capability flags. Missing flags establish that the current profiles need replacement; they do not prove whether Apple has already approved the capability in the portal. Signing preparation rejects missing capabilities before a signed build is attempted.

The existing profile check (run `43068058169`) found no Family Controls entitlement in the app/widget profiles and no monitor profile. On 2026-11-11, the account holder authorized submission through Apple’s entitlement request form. Apple confirmed submission and said it would review the request and contact the account with a status update. A subsequent check of the saved Developer Portal settings showed Family Controls (Distribution) Assigned and enabled for all five identifiers. Regenerated profile contents are being verified before signing; the earlier request receipt alone did not establish approval. No Screen Time TestFlight build has been delivered yet. Authorization, shielding, background expiry, pause/resume and actual picker appearance require a signed physical-device check.
