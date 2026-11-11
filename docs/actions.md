# Downloaded actions

Runtime `zorid-3` includes the `ZoridActions` local Expo module and a version-pinned Expo Widgets adapter. Installing this binary is required once. Subsequent signed whole-library releases can install new JavaScript handlers composed from its existing capabilities. Independent app bundle delivery and cross-device data synchronization are still separate future work.

## Execution

A widget button carries an app ID, action ID, immutable action-bundle version, stable invocation ID and JSON arguments. App Intents dispatch it into a fresh JavaScriptCore context, without requiring a mounted React screen. The ordinary `zorid-action:` target uses WidgetKit's AppIntent execution. `zorid-activity-action:` explicitly opts an activity-management action into LiveActivityIntent execution in the containing app process. iOS still controls authorization and execution availability.

The handler receives synchronous `records`, `outbox`, `surfaces` APIs and the invocation time. These APIs are native implementations; downloaded handlers do not import React Native modules. Handler imports are bundled on WSL with `bun run build:actions`, producing a tracked source string. CI rejects a stale generated bundle. Hermes function source serialization is not used.

SQLite commits record mutations, a duplicate receipt, queued work and surface effects in one transaction. The same request and invocation ID returns the existing result; changed requests cannot reuse an ID. A failed handler or capability call rolls back everything, even if JavaScript catches a capability exception. Schema-aware reads/deletes reject unexpected record versions; writes refuse downgrades. A changed bundle manifest requires a new version. Historical versions can be reinstalled for rollback, provided their record formats remain compatible.

## Shared records

Both native actions and Expo SQLite open `group.app.zorid.mobile/SQLite/zorid.db`. Initial app bootstrap uses SQLite backup to migrate the previous sandbox database, including uncheckpointed WAL writes. It retains the original file and does not replace an existing shared database. Extensions cannot initialize the database before app bootstrap. Back up personal records before experiments with future incompatible schema changes; rolling back code does not undo data changes.

Native record access is scoped to `appId`, matching the documents' feature namespace. The focus demo uses `productivity`. A small `state/focus-current` record identifies the session to publish, so surface updates read the current durable session rather than a captured UI snapshot. App mutations also reread records inside exclusive transactions and refresh after native record events and foreground activation.

## Surfaces and offline recovery

Surface effects apply after the database commit. An App Group file lock and per-surface sequence checkpoints coordinate app and extension processes. Every iOS focus publication uses this path. Widget timelines update from committed data; ActivityKit updates or ends existing activities. Explicit `startActivity` requests may create an absent activity from an eligible app context. If iOS rejects background creation, the effect remains pending for a foreground retry.

Refresh failure is separate from action failure: saved records remain saved. The app retries effects on startup, foreground activation and later action calls. `actions.flushEffects(appId)` exposes explicit retry. An interrupted effect may be reapplied, so surface operations are idempotent state replacements. Core pending-effect batches contain eight effects; one flush processes at most 32 before reporting remaining work. Direct Expo Widgets publication remains available for other platforms, but the iOS demo does not bypass native ordering.

The focus demo's Pause, Resume and Finish share one handler between the app, widget and Live Activity. Targets include the session revision. Old rendered buttons cannot modify a newer state or a different session. Native timestamp-based countdowns continue without per-second JavaScript. They do not guarantee that an expired session has already been committed in the background; an eligible action/app execution reconciles the stored intervals.

The outbox durably stores named JSON jobs and supports scoped read/acknowledgment. It is not a synchronization engine or automatic network worker. A consumer must deliver a job, deduplicate by job ID, then acknowledge it. Offline jobs remain pending; iOS does not guarantee an immediate retry opportunity.

## Limits and trust

Handlers are short, synchronous functions delivered by a trusted signed-code host. Capability checks and scoped storage are not isolation between hostile apps: the trusted running library can register bundles and access its native bridge. There is no claimed hard JavaScriptCore CPU/memory timeout. Quotas bound source/request sizes, SDK operations, record/list payloads and queued work. Large collections need application-level organization; this first action API does not provide unbounded scans, arbitrary native integrations or continuous background execution.

New native capabilities still require a binary rebuild. Notification/calendar integrations, attachments, automatic network delivery, system authentication policies and independent per-app permission approvals are not implemented by this change. Home Screen actions and app navigation use the separate [route SDK](routes.md). See [the SDK reference](../src/actions/README.md) and [native adapter notes](action-native-adapter-notes.md).

## Verification

Bun tests exercise the generated handler in fresh isolated contexts with SQLite-backed records. Native CI executes JavaScriptCore/SQLite regression checks, legacy WAL migration and the compiled focus handler's full pause/resume/finish lifecycle. A separate Swift check covers route parsing/persistence. Native compilation and signing run on GitHub; actual iPhone widget rendering, lock-state behavior, gestures and background ActivityKit interactions require device acceptance.
