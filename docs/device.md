# Device APIs for deployed apps

Runtime `zorid-5` adds the installed `ZoridDevice` module. Compatible directly deployed React Native JavaScript can call its APIs without another binary build. Older binaries and web report `device.available === false`; operations reject with an upgrade message. These APIs are separate from widget/Live Activity action handlers and do not add background JavaScript execution.

```ts
import { device } from '../device';

const capabilities = await device.capabilities();
if (capabilities.available && capabilities.features.authentication) {
  const result = await device.authentication.authenticate({
    policy: 'deviceOwner', reason: 'Unlock my journal',
  });
  if (!result.success) return;
}
```

Capabilities are versioned (`version: 1`, `platform: 'ios'`) and report installed feature flags: `authentication`, `notifications`, `clipboard`, `photosPicker`, `photosAdd`, `calendar` and `reminders`. They do not establish authorization, hardware availability or physical-device behavior. Check each domain's status and handle denied, restricted, canceled and interrupted outcomes.

The native module accepts `call(domain, operation, JSON)` internally; applications use the typed namespaces below. Arguments are snapshotted before the native call. Request and response JSON are each bounded to 8 MiB. Arguments must be plain, lossless JSON: omit optional fields instead of passing `undefined`; no getters, custom prototypes, functions, symbols, cycles, sparse arrays, nonfinite numbers, negative zero or unsafe integers. Nesting is limited to 32 levels and 100,000 values. Native operation validation remains authoritative for Apple-specific constraints. Native errors propagate; malformed native JSON is rejected.

All timestamps below use epoch milliseconds unless a field explicitly states seconds. OS grants belong to the installed Zorid app. An `appId` namespaces feature data; it is not an iOS security boundary between trusted downloaded interfaces. Nothing here sends personal data to the paired deployment host automatically.

## Authentication

- `device.authentication.status()` reports biometry (`none`, `touchID`, `faceID`, `opticID` or `unknown`), and separate `biometric`/`deviceOwner` availability and reason fields.
- `cancel()` invalidates the active authentication context and returns `{ cancelled: true }`; the pending authentication reports its actual cancellation outcome.
- `authenticate({ policy, reason, cancelTitle?, fallbackTitle?, reuseDuration? })` uses `policy: 'biometric' | 'deviceOwner'` and returns `{ success, reason }`. The device-owner policy can use the system passcode fallback. Cancellation and unsuccessful authentication are outcomes, not proof of an app unlock. Reasons must be nonempty and at most 4,096 UTF-8 bytes; optional titles have the same bound. Reuse duration is bounded by Apple's native maximum, and only one authentication prompt can be active.

Authentication presents Apple's UI and never exposes biometric data. An authentication check by itself does not encrypt records. Reuse the installed SecureStore API for small Keychain values, including its biometric-protected item options. These are separate responsibilities.

## Local notifications

```ts
await device.notifications.request({ alert: true, sound: true, badge: true });
await device.notifications.categories({
  appId: 'focus', categories: [{
    id: 'session', actions: [{ id: 'open', title: 'Open session', options: ['foreground'] }],
  }],
});
await device.notifications.schedule({
  appId: 'focus', id: 'session-finished', title: 'Focus complete',
  categoryId: 'session', data: { sessionId: 'session-123' }, sound: 'default',
  trigger: { type: 'delay', seconds: 25 * 60 },
});
```

| Method | Contract |
| --- | --- |
| `status()` | Authorization plus alert, sound, badge, Lock Screen and Notification Center settings. |
| `request({ alert?, sound?, badge?, provisional? })` | Requests system authorization; returns status plus `granted`. |
| `categories({ appId, categories })` | Registers this app namespace's categories and action buttons. Each category has `id` and `actions`; actions have `id`, `title`, optional `options` (`foreground`, `destructive`, `authenticationRequired`) and optional `textInput: { buttonTitle, placeholder? }`. |
| `schedule(input)` | Schedules/replaces the namespace's notification ID; returns `{ id }`. Input requires `appId`, `id`, `trigger`; optional `title`, `subtitle`, `body`, `sound: 'default' | null`, `badge`, `categoryId`, and JSON-object `data`. |
| `pending(appId)` / `delivered(appId)` | Returns `{ notifications }` for that namespace. Delivered entries additionally include `deliveredAt`. |
| `cancel(appId, ids?)` / `removeDelivered(appId, ids?)` | Removes selected IDs, or all notifications in that namespace when IDs are omitted. |
| `responses(appId)` | Returns `{ responses, persistenceError, overflowed }`. A response includes receipt `id`, `notificationId`, `actionId`, optional entered `text`, optional `textTruncated: true`, `data`, and `receivedAt`. |
| `acknowledge(appId, receiptIds)` | Removes processed response receipts; returns `{ acknowledged: true }`. |

Triggers are `{ type: 'date', at }`, `{ type: 'delay', seconds, repeats? }`, or `{ type: 'calendar', components: { year?, month?, day?, weekday?, hour?, minute?, second? }, repeats? }`. Delay units are seconds. Native validation rejects unsupported combinations. Identifiers match `[A-Za-z0-9][A-Za-z0-9._-]*`: `appId` is at most 64 characters and notification/category/action IDs at most 128. `default` and `dismiss` are reserved action IDs. A registration call accepts up to 64 categories, each with up to four actions. Notification text fields and `data` are each limited to 16 KiB. Explicit cancel/remove lists hold at most 256 IDs; acknowledgement holds at most 128 receipts. Repeating delays require at least 60 seconds. Dates are rounded up to native whole-second resolution.

Native notification responses are captured before React starts and retained for later acknowledgement. The shared queue holds the most recent 128 responses across namespaces and its protected on-device file is bounded to 4 MiB. Check `overflowed` and `persistenceError`; the queue is not an unlimited guaranteed-delivery log. Entered text is bounded to 64 KiB and sets `textTruncated` when shortened. Read receipts when the app launches or returns to the foreground, process idempotently, and acknowledge only after saving the result. A failed acknowledgement persistence retains the receipt. Button taps do not execute downloaded JavaScript while React is absent. OS delivery timing, notification settings and user interaction remain outside the bridge's control. This is local notification support; it does not add APNs registration or remote pushes.

## Clipboard and Photos

| Method | Contract |
| --- | --- |
| `device.media.clipboardStatus()` | Returns `{ hasStrings, hasURLs, changeCount }` without retrieving contents. |
| `clipboardGet()` | Returns `{ text, url }`, each nullable. Reading another app's pasteboard may invoke iOS paste approval. |
| `clipboardSet({ text?, url?, localOnly?, expiresAt? })` | Writes exactly one text or URL, up to 1 MiB; optional future expiration and local-only flag; returns `{ saved: true }`. |
| `photosPick({ selectionLimit?, filter?, ordered? })` | Presents the system picker. Limit is 1–20 (default 1), filter is `images`, `videos` or `imagesAndVideos` (default), and ordered defaults to true. Returns `{ cancelled, assets }`; cancellation has no assets. |
| `photosStatus()` / `photosRequestAdd()` | Reports/requests add-only authorization as `{ addOnly }`. |
| `photosSave({ uri, kind })` | Adds a local app-container file to Photos after add-only authorization; kind is `image` or `video`. Returns `{ saved: true, localIdentifier }`, with nullable identifier. |

Picked assets contain `uri`, `fileName`, `typeIdentifier`, nullable `mimeType`, `bytes` and `kind`. The native picker imports files into `Caches/ZoridMedia/<batch>` before the provider callback expires; imports are bounded to 256 MiB per item and 512 MiB per batch. A failed batch cleans up imported files and rejects. Cache files can be purged by iOS: move attachments to durable app storage if they must survive. Live Photos import as a still image; paired motion data is not exposed. This picker does not provide full photo-library enumeration, album browsing or unrestricted read permission.

Clipboard reads should follow an explicit user action; do not poll for personal content. Photo saving accepts app-container files, not arbitrary paths. Photos import/save and paste approval need physical-device validation.

## Calendar and Reminders

```ts
// On supported iOS versions this system add editor needs no full calendar grant.
await device.calendar.editEvent({
  title: 'Work session', start: Date.now(), end: Date.now() + 30 * 60_000,
});

await device.calendar.request({ entity: 'reminders', access: 'full' });
const { calendars } = await device.calendar.calendars('reminders');
const list = calendars.find(calendar => calendar.allowsModifications);
if (list) {
  await device.calendar.saveReminder({ title: 'Review session notes', calendarId: list.id });
}
```

| Method | Contract |
| --- | --- |
| `device.calendar.status()` | Returns `events`, `reminders` authorization and `permissionFreeEditor`. Events distinguish `writeOnly` and `full`; reminders require full access. |
| `request({ entity, access? })` | `entity` is `events` or `reminders`; `access` is `writeOnly` or `full`. Native code handles the iOS 16.4/17 permission model difference. |
| `calendars(entity)` | Returns `{ calendars: [{ id, title, color, allowsModifications, isDefault }] }`. |
| `events({ start, end, calendarIds?, limit? })` | Queries at most 366 days; limit 1–500, default 100. Returns `{ events, truncated }`. |
| `event(id)` | Returns one event or `null`. |
| `saveEvent({ event, span? })` | Creates/updates an event; returns `{ saved: true, id, event }`. With write-only access, `event` is null and `id` can be null; it does not perform an unauthorized readback. |
| `removeEvent(id, span?)` | Deletes an event. Span is `thisEvent` or `futureEvents` and also applies to saves. |
| `editEvent(event?)` | Presents Apple's editor; returns `{ action: 'saved' | 'deleted' | 'canceled', id }`. New-event editing can be permission-free on iOS 17+; existing-event editing requires full access. |
| `reminders({ calendarIds, completed?, limit? })` | Requires 1–32 selected list IDs; limit 1–500, default 100. Returns `{ reminders, truncated }`. |
| `reminder(id)` | Returns one reminder or `null`. |
| `saveReminder(reminder)` | Creates/updates and returns a reminder. |
| `setReminderCompleted(id, completed)` | Updates completion and returns a reminder. |
| `removeReminder(id)` | Deletes a reminder. |

Event input requires `title`, `start` and `end`; optional `id`, `calendarId`, `allDay`, `timeZone`, `notes`, `location`, `url` and `alarms`. At most 20 alarms are accepted. Alarm numbers are seconds relative to start, bounded to 366 days in either direction; `{ absoluteAt }` supplies an absolute epoch-millisecond alarm. Returned events also include `hasRecurrenceRules`. Reminder input requires `title`; optional `id`, `calendarId`, `notes`, `url`, nullable `dueAt`/`startAt`, integer `priority` 0–9 and `completed`. Returned reminders add nullable `completedAt`. Event/reminder text fields are bounded to 65,536 UTF-8 bytes. Updates preserve omitted optional fields; explicit null clears nullable fields, and a supplied alarm array replaces the existing alarms. IDs come from EventKit and can change; retain your own local record identity separately.

Queries expose selected personal data to the trusted deployed app and do not automatically synchronize it. Their result limits bound bridge output; underlying EventKit reminder fetching can still materialize more items before truncation. Calendar/reminder writes and deletes affect the user's actual stores. The bridge does not serialize or programmatically edit recurrence rules; existing rules remain when other fields are updated, and Apple's editor supplies its native editing UI. EventKit's lookup by identifier can resolve the first occurrence of a recurring series rather than a queried occurrence, so a query entry is not an independently addressable recurring event. The bridge does not make all Apple Calendar/Reminders features available.

## Reuse existing installed APIs

Use React Native `Share`/`Linking`, Expo Camera (including the installed SDK's document scanner), SecureStore, SQLite and Crypto directly. Expo FileSystem already provides sandbox files, copied system document imports, directory selection and Quick Look preview; photo picking is the separate API above. These do not require duplicate Swift bridges. See the [Apple capability catalog](apple-capabilities.md), [haptics](haptics.md), [Screen Time](screen-time.md) and [iOS build boundary](ios-builds.md).

This module does not expose location, contacts, audio recording/playback, universal links, remote push notifications or general background tasks. Those require separately implemented native APIs and, where applicable, privacy descriptions, entitlements and another binary/runtime increment.
