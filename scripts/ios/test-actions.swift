import Foundation
import SQLite3

@main
struct ZoridActionChecks {
  static var checks = 0
  static var bundleSequence = 0

  static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    guard try condition() else { throw ZoridActionError("Check failed: \(message)") }
    checks += 1
  }

  static func fails(_ message: String, _ body: () throws -> Void) throws {
    do { try body() } catch { checks += 1; return }
    throw ZoridActionError("Expected failure: \(message)")
  }

  static func failureMessage(_ body: () throws -> Void) throws -> String {
    do { try body() } catch { return error.localizedDescription }
    throw ZoridActionError("Expected an action failure")
  }

  static func encode(_ value: Any) throws -> String { try actionJSON(value) }
  static func object(_ json: String) throws -> [String: Any] { try actionParse(json) as! [String: Any] }
  static func array(_ json: String) throws -> [[String: Any]] { try actionParse(json) as! [[String: Any]] }

  static func install(_ runtime: ZoridActionRuntime, _ handler: String, app: String = "demo", capabilities: [String] = ["records", "outbox", "surfaces"], version: String? = nil) throws {
    bundleSequence += 1
    try runtime.installBundle(encode(["appId": app, "version": version ?? "test-\(bundleSequence)", "runtimeVersion": 1, "capabilities": capabilities, "handlers": ["run": handler]]))
  }

  static func invoke(_ runtime: ZoridActionRuntime, id: String = UUID().uuidString, args: Any = NSNull(), app: String = "demo", version: String? = nil) throws -> [String: Any] {
    var request: [String: Any] = ["appId": app, "actionId": "run", "invocationId": id, "args": args]
    if let version { request["bundleVersion"] = version }
    return try object(runtime.dispatch(encode(request)))
  }

  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("zorid-action-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let shared = root.appendingPathComponent("shared", isDirectory: true)
    let runtime = ZoridActionRuntime(directoryURL: shared)
    _ = try runtime.prepareDatabase(legacyDirectory: nil)

    try install(runtime, """
      function(args,sdk) {
        var old=sdk.records.get('items',args.id);
        var next={id:args.id,count:(old ? old.count : 0)+1, label:args.label};
        sdk.records.put('items',args.id,next);
        sdk.outbox.enqueue('changed',next);
        sdk.surfaces.publish({widget:'DemoWidget',activity:'DemoActivity',props:{count:next.count}});
        return next;
      }
      """)
    let args = ["id": "counter", "label": "O'Reilly \"quotes\" $(no shell) \\ unicode 🦦"]
    let first = try invoke(runtime, id: "once", args: args)
    try check((first["result"] as? [String: Any])?["count"] as? Int == 1, "action returns actual persisted result")
    try check(first["duplicate"] as? Bool == false, "first dispatch is not duplicate")
    let effects = first["effects"] as! [[String: Any]]
    try check(effects.count == 1 && effects[0]["sequence"] as? Int == 1, "effect sequence is durable and ordered")
    try check(try array(runtime.readOutbox(appId: "demo")).count == 1, "outbox committed with record")

    let cold = ZoridActionRuntime(directoryURL: shared)
    let duplicate = try invoke(cold, id: "once", args: args)
    try check(duplicate["duplicate"] as? Bool == true, "cold process replays receipt")
    try check((duplicate["result"] as? [String: Any])?["count"] as? Int == 1, "duplicate does not rerun business logic")
    try check(try array(cold.readOutbox(appId: "demo")).count == 1, "duplicate does not enqueue twice")
    try fails("invocation ID reuse with changed arguments") { _ = try invoke(cold, id: "once", args: ["id": "different"]) }
    try fails("incompatible action version") { _ = try invoke(cold, args: args, version: "future") }
    try check(try array(cold.pendingEffects(appId: "demo")).count == 1, "effect persists until applied")
    try cold.acknowledgeEffects(ids: [effects[0]["id"] as! String])
    try check(try array(cold.pendingEffects(appId: "demo")).isEmpty, "effect acknowledgement is durable")
    let afterAck = try invoke(cold, id: "once", args: args)
    try check((afterAck["effects"] as! [Any]).isEmpty, "duplicate does not replay already-applied effects")

    try install(runtime, "function(args,sdk){return sdk.records.get('items','counter');}", app: "other")
    try check(try invoke(runtime, app: "other")["result"] is NSNull, "app cannot read another namespace")
    try install(runtime, "function(args,sdk){sdk.records.put('items','counter',{count:500});return 1;}", app: "other")
    _ = try invoke(runtime, app: "other")
    try install(runtime, "function(args,sdk){return sdk.records.get('items','counter');}")
    try check((try invoke(runtime)["result"] as! [String: Any])["count"] as? Int == 1, "same record ID stays separate across apps")

    try install(runtime, """
      function(args,sdk){
        sdk.records.put('items','counter',{count:900});
        sdk.outbox.enqueue('shouldRollback',{secret:'never saved'});
        sdk.surfaces.publish({widget:'DemoWidget',props:{count:900}});
        throw new Error('fail after writes');
      }
      """)
    try fails("JS exception rolls back every effect") { _ = try invoke(runtime, id: "rollback") }
    try check(try array(runtime.readOutbox(appId: "demo")).count == 1, "failed action outbox rolled back")
    try check(try array(runtime.pendingEffects(appId: "demo")).isEmpty, "failed action surface rolled back")
    try install(runtime, "function(args,sdk){return sdk.records.get('items','counter');}")
    try check((try invoke(runtime)["result"] as! [String: Any])["count"] as? Int == 1, "failed action records rolled back")
    _ = try invoke(runtime, id: "rollback")
    try check(true, "failed invocation can retry because no receipt committed")

    let failureDatabase = try ZoridActionConnection(url: shared.appendingPathComponent("zorid.db"))
    let actionableMessage = "This focus button is outdated. Refresh the session."
    try install(runtime, """
      function(args,sdk){
        sdk.records.put('items','failed-reason',{count:900});
        sdk.surfaces.publish({widget:'DemoWidget',props:{count:900}});
        throw new Error('This focus button is outdated. Refresh the session.');
      }
      """)
    let actionableFailure = try failureMessage { _ = try invoke(runtime, id: "actionable-failure") }
    try check(actionableFailure.contains(actionableMessage), "native failure preserves the handler's actionable own message")
    try check(try failureDatabase.rows("SELECT id FROM documents WHERE feature=? AND collection=? AND id=?", ["demo", "items", "failed-reason"]).isEmpty, "actionable failure rolls back record writes")
    try check(try array(runtime.pendingEffects(appId: "demo")).isEmpty, "actionable failure rolls back surface writes")
    try check(try failureDatabase.rows("SELECT invocation_id FROM zorid_action_receipts WHERE app_id=? AND invocation_id=?", ["demo", "actionable-failure"]).isEmpty, "actionable failure never commits a receipt")

    let genericFailure = "The app action failed; no changes were saved."
    let unsafeFailures = [
      "throw null;", "throw 42;", "throw 'primitive failure';", "throw Symbol('failure');",
      "throw {toString:function(){return 'must not stringify';}};",
      "throw Object.defineProperty({},'message',{get:function(){return 'must not invoke getter';}});",
      "throw Object.defineProperty({},'message',{get:function(){throw new Error('secondary failure');}});",
      "throw new Proxy({},{getOwnPropertyDescriptor:function(){throw new Error('descriptor trap');}});",
      "throw new Error('unsafe\\ncontrol');", "throw new Error('unsafe\\u0000control');",
      "throw new Error('unsafe\\u007fcontrol');", "throw new Error('unsafe\\u009fcontrol');",
    ]
    for handler in unsafeFailures {
      try install(runtime, "function(args,sdk){" + handler + "}")
      let message = try failureMessage { _ = try invoke(runtime) }
      try check(message == genericFailure, "unsafe thrown value retains a fixed fallback without evaluating accessors")
    }
    try install(runtime, "function(){throw new Error('x'.repeat(1000));}")
    let boundedFailure = try failureMessage { _ = try invoke(runtime) }
    try check(boundedFailure.contains(String(repeating: "x", count: 240)) && !boundedFailure.contains(String(repeating: "x", count: 241)), "handler error detail is bounded to 240 characters")
    try install(runtime, "function(){throw new Error('x'.repeat(239)+'🦦');}")
    let unicodeFailure = try failureMessage { _ = try invoke(runtime) }
    try check(unicodeFailure.contains(String(repeating: "x", count: 239)) && !unicodeFailure.contains("�"), "bounded detail does not split a surrogate pair")
    try install(runtime, "function(){Object.getOwnPropertyDescriptor=function(){return {value:'forged'};};String.prototype.slice=function(){return 'forged';};RegExp.prototype.test=function(){return true;};throw new Error('original reason');}")
    let intrinsicFailure = try failureMessage { _ = try invoke(runtime) }
    try check(intrinsicFailure.contains("original reason") && !intrinsicFailure.contains("forged"), "handler cannot replace captured error formatting intrinsics")
    try install(runtime, "function(args,sdk){try{sdk.records.put('items','illegal',{value:1});}catch(e){}throw new Error('replacement reason');}", capabilities: [])
    let capabilityFailure = try failureMessage { _ = try invoke(runtime) }
    try check(capabilityFailure == "The app action lacks the records capability.", "native capability failure takes precedence over a later JavaScript exception")

    try install(runtime, "function(args,sdk){sdk.records.put('parse-intrinsic','record',{value:7});}")
    _ = try invoke(runtime)
    try install(runtime, "function(args,sdk){JSON.parse=function(){return {forged:true};};return {get:sdk.records.get('parse-intrinsic','record'),list:sdk.records.list('parse-intrinsic')};}")
    let parsedRecords = try invoke(runtime)["result"] as! [String: Any]
    try check((parsedRecords["get"] as? [String: Any])?["value"] as? Int == 7, "record get uses the captured JSON parser")
    try check(((parsedRecords["list"] as? [[String: Any]])?.first)?["value"] as? Int == 7, "record list uses the captured JSON parser")
    try failureDatabase.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["demo", "invalid-json", "record", 1, 0, "{"])
    for operation in ["sdk.records.get('invalid-json','record')", "sdk.records.list('invalid-json')"] {
      try install(runtime, "function(args,sdk){sdk.records.put('items','invalid-parse-write',{value:1});try{" + operation + ";}catch(e){}return null;}")
      let parseFailure = try failureMessage { _ = try invoke(runtime) }
      try check(parseFailure == "Stored action record contains invalid JSON.", "invalid stored JSON remains a latched native capability error")
      try check(try failureDatabase.rows("SELECT id FROM documents WHERE feature=? AND collection=? AND id=?", ["demo", "items", "invalid-parse-write"]).isEmpty, "invalid stored JSON rolls back preceding writes")
    }

    try install(runtime, "function(args,sdk){try{sdk.records.put('items','illegal',{value:1});}catch(e){}return 'caught';}", capabilities: [])
    try fails("caught capability error still rejects transaction") { _ = try invoke(runtime) }
    try install(runtime, "async function(args,sdk){sdk.records.put('items','illegal',{value:1});return 1;}")
    try fails("asynchronous action forbidden") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){return sdk.records.get('items','illegal');}")
    try check(try invoke(runtime)["result"] is NSNull, "async action writes were rolled back")
    try install(runtime, "function(args,sdk){sdk.records.put('../other','x',{});return true;}")
    try fails("path traversal in collection rejected") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){for(var i=0;i<257;i++)sdk.records.put('items','x',{i:i});return true;}")
    try fails("operation quota rolls back") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){sdk.surfaces.publish({widget:'DemoWidget',props:{},id:'forged'});}")
    try fails("caller cannot forge durable effect metadata") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){sdk.surfaces.publish({widget:'DemoWidget',props:{},timeline:[{date:2,props:{}},{date:1,props:{}}]});}")
    try fails("timeline ordering validated") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){sdk.surfaces.publish({widget:'DemoWidget',props:{nested:[null]}});}")
    try fails("widget effect null rejected before commit") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){sdk.records.put('items','x',{},0);}")
    try fails("invalid record version") { _ = try invoke(runtime) }

    let pending = try array(runtime.readOutbox(appId: "demo"))
    try runtime.acknowledgeOutbox(appId: "other", ids: pending.map { $0["id"] as! String })
    try check(try array(runtime.readOutbox(appId: "demo")).count == 1, "outbox acknowledgement is owner scoped")
    try runtime.acknowledgeOutbox(appId: "demo", ids: pending.map { $0["id"] as! String })
    try check(try array(runtime.readOutbox(appId: "demo")).isEmpty, "outbox only removed after acknowledged")
    try fails("unsupported runtime version rejected") {
      try runtime.installBundle(encode(["appId":"demo", "version":"future", "runtimeVersion":2,"capabilities":[],"handlers":["run":"function(){}"]]))
    }
    try fails("unknown native capability rejected") { try install(runtime, "function(){}", capabilities: ["uninstalled-calendar"]) }

    // Back up a live WAL database; do not copy just its main file or delete the source.
    let legacy = root.appendingPathComponent("legacy", isDirectory: true)
    let migrated = root.appendingPathComponent("migrated", isDirectory: true)
    try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
    let original = try ZoridActionConnection(url: legacy.appendingPathComponent("zorid.db"))
    try original.script("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE documents(feature TEXT,collection TEXT,id TEXT,schema_version INTEGER,updated_at INTEGER,data TEXT,PRIMARY KEY(feature,collection,id));")
    try original.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["demo","items","legacy",1,1,"{\"preserved\":true}"])
    let migration = ZoridActionRuntime(directoryURL: migrated)
    _ = try migration.prepareDatabase(legacyDirectory: legacy.path)
    try check(FileManager.default.fileExists(atPath: legacy.appendingPathComponent("zorid.db").path), "original retained after migration")
    try install(migration, "function(args,sdk){return sdk.records.get('items','legacy');}")
    try check((try invoke(migration)["result"] as! [String: Any])["preserved"] as? Bool == true, "migration includes uncheckpointed WAL data")
    try install(migration, "function(args,sdk){sdk.records.put('items','legacy',{newer:true});}")
    _ = try invoke(migration)
    _ = try migration.prepareDatabase(legacyDirectory: legacy.path)
    try install(migration, "function(args,sdk){return sdk.records.get('items','legacy');}")
    try check((try invoke(migration)["result"] as! [String: Any])["newer"] as? Bool == true, "repeated migration never overwrites shared edits")

    let bootstrapURL = root.appendingPathComponent("bootstrap-before-prepare", isDirectory: true)
    let bootstrap = ZoridActionRuntime(directoryURL: bootstrapURL, legacyDirectoryURL: legacy)
    try install(bootstrap, "function(args,sdk){return sdk.records.get('items','legacy');}")
    try check((try invoke(bootstrap)["result"] as! [String: Any])["preserved"] as? Bool == true, "install before prepare detects and migrates existing WAL records")
    _ = try bootstrap.prepareDatabase(legacyDirectory: legacy.path)
    try check((try invoke(bootstrap)["result"] as! [String: Any])["preserved"] as? Bool == true, "explicit prepare after automatic migration keeps records")
    let prematureExtension = ZoridActionStore(directoryURL: root.appendingPathComponent("premature-extension"), isExtension: true)
    try fails("extension cannot create empty database before app migration") { _ = try prematureExtension.prepare(legacyDirectory: nil) }
    try check(!FileManager.default.fileExists(atPath: try prematureExtension.directory().appendingPathComponent("zorid.db").path), "extension refusal leaves no empty database")

    for invalidValue in ["{nested:{bad:NaN}}", "{nested:[Infinity]}", "{nested:{bad:undefined}}", "{nested:{bad:function(){}}}", "{nested:{bad:Symbol('x')}}"] {
      try install(runtime, "function(args,sdk){sdk.records.put('json','guard',{value:99});sdk.outbox.enqueue('invalid'," + invalidValue + ");}")
      try fails("non-JSON nested value rolls back the action") { _ = try invoke(runtime) }
    }
    try install(runtime, "function(args,sdk){JSON.stringify=function(){return '{}';};sdk.records.put('json','guard',{bad:NaN});}")
    try fails("action cannot replace strict stringify intrinsic") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){sdk.records.put('json','guard',{value:99});return {bad:Infinity};}")
    try fails("nonfinite return value rolls back prior writes") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){return sdk.records.get('json','guard');}")
    try check(try invoke(runtime)["result"] is NSNull, "invalid nested JSON never commits prior writes")

    try install(runtime, "function(args,sdk){sdk.records.put('future','record',{looksLikeOldData:true},2);}")
    _ = try invoke(runtime)
    for operation in ["sdk.records.get('future','record')", "sdk.records.list('future')", "sdk.records.put('future','record',{looksLikeOldData:false})", "sdk.records.delete('future','record')"] {
      try install(runtime, "function(args,sdk){" + operation + ";}")
      try fails("stale schema action cannot read or downgrade future record") { _ = try invoke(runtime) }
    }
    try install(runtime, "function(args,sdk){return sdk.records.get('future','record',2);}")
    try check((try invoke(runtime)["result"] as! [String: Any])["looksLikeOldData"] as? Bool == true, "explicit future schema read preserves data")
    try install(runtime, "function(args,sdk){sdk.records.delete('future','record',2);}")
    _ = try invoke(runtime)
    try install(runtime, "function(args,sdk){return sdk.records.get('future','record');}")
    try check(try invoke(runtime)["result"] is NSNull, "explicit schema-aware deletion succeeds")

    try install(runtime, "function(args,sdk){sdk.surfaces.publish({activity:'DemoActivity',props:{},startActivity:true,endActivity:true});}")
    try fails("conflicting activity lifecycle flags rejected") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){sdk.surfaces.publish({activity:'DemoActivity',props:{},startActivity:true,url:'https://example.com'});}")
    try fails("activity URL must use installed scheme") { _ = try invoke(runtime) }
    try install(runtime, "function(args,sdk){sdk.surfaces.publish({activity:'DemoActivity',props:{},startActivity:true,url:'zorid://apps/demo/focus'});}")
    try check((try invoke(runtime)["effects"] as! [Any]).count == 1, "valid activity start request commits durable effect")

    final class EventCounter { var count = 0 }
    let eventCounter = EventCounter()
    let observer = NotificationCenter.default.addObserver(forName: ZoridActionRuntime.recordsChangedNotification, object: nil, queue: nil) { _ in eventCounter.count += 1 }
    defer { NotificationCenter.default.removeObserver(observer) }
    try install(runtime, "function(args,sdk){return sdk.records.list('json');}")
    _ = try invoke(runtime)
    try check(eventCounter.count == 0, "read-only action emits no records change event")
    try install(runtime, "function(args,sdk){sdk.surfaces.publish({widget:'DemoWidget',props:{value:1}});}")
    _ = try invoke(runtime)
    try check(eventCounter.count == 0, "surface-only publication emits no records change event")
    try install(runtime, "function(args,sdk){sdk.records.put('events','record',{value:1});}")
    _ = try invoke(runtime, id: "event-once")
    try check(eventCounter.count == 1, "committed record mutation emits once")
    _ = try invoke(runtime, id: "event-once")
    try check(eventCounter.count == 1, "duplicate action emits no change event")
    try install(runtime, "function(args,sdk){sdk.records.put('events','record',{value:2});throw new Error('rollback');}")
    try fails("event not emitted for rollback") { _ = try invoke(runtime) }
    try check(eventCounter.count == 1, "rollback emits no records change event")

    try install(runtime, "function(args,sdk){for(var i=0;i<10;i++)sdk.surfaces.publish({widget:'DemoWidget',props:{index:i}});}", app: "pagination")
    _ = try invoke(runtime, app: "pagination")
    let firstPage = try array(runtime.pendingEffects(appId: "pagination"))
    try check(firstPage.count == 8, "default surface page is bounded at eight effects")
    let firstCursor = (firstPage.last!["sequence"] as! NSNumber).int64Value
    let secondPage = try array(runtime.pendingEffects(appId: "pagination", afterSequence: firstCursor))
    try check(secondPage.count == 2, "native cursor reaches effects behind a deferred first page")
    try check((secondPage.first!["sequence"] as! NSNumber).int64Value > firstCursor, "cursor page strictly follows last sequence")
    let secondCursor = (secondPage.last!["sequence"] as! NSNumber).int64Value
    try check(try array(runtime.pendingEffects(appId: "pagination", afterSequence: secondCursor)).isEmpty, "cursor page ends without repeating deferred effects")
    try check(try array(runtime.pendingEffects(appId: "pagination")).count == 8, "cursor reading does not acknowledge earlier effects")
    try fails("negative effect cursor rejected") { _ = try runtime.pendingEffects(appId: "pagination", afterSequence: -1) }

    let fixedSource = "function(){return 'stable';}"
    try install(runtime, fixedSource, version: "immutable-version")
    try install(runtime, fixedSource, version: "immutable-version")
    try check(try invoke(runtime, version: "immutable-version")["result"] as? String == "stable", "identical bundle registration remains idempotent")
    try fails("same version cannot change handler semantics") { try install(runtime, "function(){return 'changed';}", version: "immutable-version") }
    try install(runtime, "function(){return 'new';}", version: "newer-version")
    try fails("historical version cannot be reused for different code") { try install(runtime, "function(){return 'changed';}", version: "immutable-version") }
    try install(runtime, fixedSource, version: "immutable-version")
    try check(try invoke(runtime, version: "immutable-version")["result"] as? String == "stable", "rollback can select identical historical version")
    var parseDescription = ""
    do { _ = try actionParse("{invalid-PRIVATE-PAYLOAD}") }
    catch { parseDescription = error.localizedDescription }
    try check(parseDescription == "Invalid action JSON.", "JSON parse errors fail without revealing input")

    let restrictionApp = "restrictions"
    try install(runtime, "function(args,sdk){sdk.records.put('state','timer',{running:true});sdk.screenTime.apply({policyId:'focus',sessionId:'session-1',endsAt:sdk.now+1500000});return 'queued';}", app: restrictionApp, capabilities: ["records", "screenTime"])
    let restricted = try invoke(runtime, id: "restrict-once", app: restrictionApp)
    let restrictionEffects = restricted["effects"] as! [[String: Any]]
    try check(restrictionEffects.count == 1 && restrictionEffects[0]["screenTime"] is [String: Any], "Screen Time request commits as a durable effect")
    try check(restrictionEffects[0]["widget"] == nil && restrictionEffects[0]["props"] == nil, "restriction effect is independent of widget rendering")
    _ = try invoke(runtime, id: "restrict-once", app: restrictionApp)
    try check(try array(runtime.pendingEffects(appId: restrictionApp)).count == 1, "duplicate action does not enqueue duplicate restrictions")
    try install(runtime, "function(args,sdk){sdk.screenTime.apply({clear:true});}", app: restrictionApp, capabilities: ["screenTime"])
    let cleared = try invoke(runtime, app: restrictionApp)
    try check(((cleared["effects"] as! [[String: Any]])[0]["screenTime"] as! [String: Any])["clear"] as? Bool == true, "clear is queued without requiring layout or records")
    try install(runtime, "function(args,sdk){return typeof sdk.screenTime;}", app: "no-restrictions", capabilities: [])
    try check(try invoke(runtime, app: "no-restrictions")["result"] as? String == "undefined", "optional Screen Time SDK is absent without declared capability")
    for invalid in ["{clear:false}", "{clear:1}", "{clear:true,policyId:'focus'}", "{policyId:'../escape',sessionId:'s',endsAt:sdk.now+10000}", "{policyId:'focus',sessionId:'s',endsAt:true}", "{policyId:'focus',sessionId:'s',endsAt:sdk.now+86400001}", "{policyId:'focus',sessionId:'s',endsAt:1.5}", "{policyId:'focus',sessionId:'s',endsAt:sdk.now+10000,tokens:['private']}"] {
      try install(runtime, "function(args,sdk){sdk.records.put('state','rollback',{bad:true});try{sdk.screenTime.apply(" + invalid + ");}catch(e){};}", app: "restriction-rollback", capabilities: ["records", "screenTime"])
      try fails("invalid Screen Time command latches failure even if handler catches") { _ = try invoke(runtime, app: "restriction-rollback") }
    }
    try check(try array(runtime.pendingEffects(appId: "restriction-rollback")).isEmpty, "invalid restriction never leaves a device effect")
    try install(runtime, "function(args,sdk){return sdk.records.get('state','rollback');}", app: "restriction-rollback")
    try check(try invoke(runtime, app: "restriction-rollback")["result"] is NSNull, "invalid restriction rolls back prior record writes")
    try install(runtime, "function(args,sdk){sdk.screenTime.apply({clear:true});throw new Error('cancel');}", app: "restriction-rollback", capabilities: ["screenTime"])
    try fails("handler failure rolls back a valid restriction effect") { _ = try invoke(runtime, app: "restriction-rollback") }
    try check(try array(runtime.pendingEffects(appId: "restriction-rollback")).isEmpty, "rolled-back restriction cannot apply later")
    try install(runtime, "function(args,sdk){sdk.surfaces.publish({widget:'DemoWidget',props:{},screenTime:{clear:true}});}", app: "restriction-bypass", capabilities: ["surfaces"])
    try fails("surface capability cannot smuggle Screen Time changes") { _ = try invoke(runtime, app: "restriction-bypass") }

    print("Native action checks passed: \(checks)")
  }
}
