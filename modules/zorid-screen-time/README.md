# Screen Time native bridge

Deployed JavaScript chooses named policies and their session deadlines. iOS presents `FamilyActivityPicker`; selected app/category tokens stay in device-local App Group files and never appear in JS, deployment manifests or logs. Profiles are namespaced by validated tool `appId` and `policyId` (up to 16 profiles per tool).

The `ZoridScreenTime` Expo module exposes:

- `status(appId): Promise<string>` returns JSON `{available:true,authorization:'notDetermined'|'denied'|'approved',policies:[{id,mode,applicationCount,categoryCount}],active:{policyId,sessionId,endsAt}|null}`. It clears expired active restrictions and discards invalidated selections when authorization is absent.
- `requestAuthorization(): Promise<void>` requests individual authorization. Before requesting a new grant, previously saved opaque selections are discarded because Apple invalidates them on revocation.
- `editPolicy(appId,policyId,mode): Promise<string>` presents the native picker, returns status after Save or Cancel, and never changes the previous policy on Cancel. Pause the active policy before editing it.
- `deletePolicy(appId,policyId): Promise<void>` also clears that policy if active.
- `clear(appId): Promise<void>` is the explicit recovery/unblock entrance.
- `apply(appId,commandJSON): Promise<void>` invokes the same controller as the durable native-action adapter. Active command is `{policyId,sessionId,endsAt}` (integer epoch milliseconds within 24 hours); clearing command is `{clear:true}`. Use one ordered action path for a given tool: mixing direct calls with older durable queued effects can otherwise overwrite a newer request.

For timer control from app, widget or Live Activity, prefer the durable action SDK integration so record changes and queued effects remain in order. A Screen Time effect failure does not mean the timer record rolled back; the UI must show the error and must not claim successful blocking.

Blocklist supports selected apps and app categories; an empty blocklist is rejected. Allowlist supports up to 50 individual app exceptions. With no exceptions, all shieldable other apps are blocked; Zorid itself remains available. Website selection is currently rejected. A policy belongs to one installation: tokens are not portable sync data.

The monitor extension compiles the same extension-safe controller and planner, without React, Expo or a JS timer. Activation writes native deadline metadata, starts a nonrepeating Device Activity schedule, then applies the named Managed Settings store. Scheduling failure clears restrictions. Old monitor callbacks cannot clear a replacement session because each activation has a unique monitor name and a deadline guard. The device clears restrictions on native interval-end callbacks or status reconciliation. Pausing/finishing explicitly clears them.

Device Activity schedules require at least 15 minutes. For shorter remaining timers, the schedule starts in the past so the whole monitoring interval remains at least 15 minutes, while retaining the requested future deadline. Apple documents ongoing interval registration; the short-remaining-session behavior still requires physical-device acceptance. Callbacks occur when the device is in use and are not a second-precise background timer guarantee.

Native capability, extension and entitlement changes require a binary rebuild. Later JavaScript UI and policy orchestration can be deployed directly. Individual authorization is revocable and does not prevent app deletion. TestFlight distribution requires approved Family Controls distribution capability and refreshed provisioning profiles for the main app, widget intent extension, monitor and both shield extensions. Simulator compilation does not establish real-device enforcement.

The regenerated five-target App Store profiles passed the runner's [capability readiness check](https://github.com/tingkai-c/zorid-mobile/actions/runs/43074465570); separate ad-hoc profiles still need updating. [TestFlight build 27](https://github.com/tingkai-c/zorid-mobile/actions/runs/43076740068) compiled, signed all five targets and uploaded successfully; the [Apple status check](https://github.com/tingkai-c/zorid-mobile/actions/runs/43083579423) confirms it is valid and assigned to internal testing. Physical-device installation remains unverified. It also includes a separate [UIKit haptics bridge](../../docs/haptics.md) for deployed UI interactions. See [delivery evidence and remaining device checks](../../docs/verification.md#screen-time-focus-protection).

Official references:

- [Family Controls authorization](https://developer.apple.com/videos/play/wwdc2022/110336/)
- [Allowlist exceptions and limit](https://developer.apple.com/documentation/managedsettings/shieldsettings/activitycategorypolicy/all(except:))
- [Minimum monitoring interval](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/monitoringerror/intervaltooshort)
- [Starting an ongoing monitoring interval](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/startmonitoring(_:during:events:))
- [Distribution entitlement](https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement)

Custom shield configuration and action extensions expose Apple’s nine public appearance fields, bounded PNG/SF Symbol icons, blur, dynamic RGBA colors, and version-gated menus/responses to deployed code. Use `configureShield` and `getShield`; see the [complete API and overlap behavior](../../docs/screen-time.md#custom-blocking-screen). The configuration datasource only reads prepared state. It does not execute JavaScript or change restrictions.
