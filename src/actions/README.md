# Downloaded actions SDK

`actions` from `src/actions` talks to the installed `ZoridActions` module. It throws an explicit availability error on older binaries. The pure `types`, `codec`, and dependency-injected `client` modules also run without React Native.

Install a bundle before invoking it. Each app/version pair is immutable: change the version whenever handler source or capabilities change. Reinstalling an identical version or selecting a previously installed version for rollback is allowed:

```ts
await actions.install({
  appId: 'notes',
  version: 'notes-actions-1',
  runtimeVersion: 1,
  capabilities: ['records', 'outbox'],
  handlers: { archive: bundledArchiveSource },
});
await actions.invoke('notes', 'archive', { noteId: 'note-123' }, {
  bundleVersion: 'notes-actions-1',
});
```

Bundle each handler into a standalone synchronous function expression on the host. Bundle imports into that source; it cannot import modules, reference React state, or rely on closures from the app. Do not build source with `Function.toString()` on the phone: Hermes does not guarantee preservation of function source. The installed native JavaScriptCore runtime supplies the `ActionSDK` argument and enforces capability access. Downloaded code remains trusted code from the paired host; the runtime is not a hostile-code sandbox and does not promise a hard JavaScript execution timeout.

Record reads and deletes accept an optional expected schema version, defaulting to 1; mismatches fail instead of interpreting future data as an older format. Writes cannot downgrade an existing record's schema version. Records, the invocation receipt, outbox entries, and surface effects commit in one native transaction. `records` access is scoped to the bundle's `appId`, which matches the documents' feature namespace. An action's native failure rolls everything back. Reusing the same invocation ID and request returns the saved receipt, allowing callers to retry safely. Reusing that ID for a different request is rejected. The SDK serializes app-side installation and dispatch calls; native SQLite also coordinates independent processes.

Surface refreshes run after that commit. A refresh failure returns `surfaceError` alongside the successful action result; records remain saved and effects remain pending. Retry with `actions.flushEffects(appId)`, including on foreground/resume. The SDK never acknowledges surface effects itself or reports a pending refresh as applied.

For widgets, use `encodeActionTarget({appId, actionId, invocationId, args, bundleVersion})` as the button target. The default `zorid-action:` prefix uses the normal widget action path. Pass `{execution: 'activity'}` only for an action that manages an existing Live Activity; `zorid-activity-action:` opts into its native intent execution path. Keep the invocation ID stable for the same rendered state and produce a new ID after that state changes. Both encodings preserve UTF-8 using only JavaScript built-ins available in the isolated runtime. The base64url widget payload is limited to 32,768 characters, while direct app dispatch supports up to 64 KiB of JSON. They are routing descriptions, not secrets or authorization tokens.

`actions.readOutbox(appId)` returns up to eight oldest pending records. Deliver work to its real consumer, then call `actions.acknowledgeOutbox(appId, ids)` for successful IDs and read the next batch. Acknowledge at most 256 IDs per call. Retrying delivery must use the outbox entry's stable ID for downstream deduplication. There is no automatic network worker or cross-device synchronization service in this SDK; pending entries survive while offline, but their presence is not proof of remote delivery.

Native runtime limits also bound handler counts/source sizes, per-action record operations, record sizes, pending effects/outbox entries and list results. Large data sets need paginated application-level record organization; this first action API does not promise arbitrary unbounded scans or long-running work.
