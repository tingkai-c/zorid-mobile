import Foundation
import CoreFoundation
import JavaScriptCore

/// An extension-safe executor for short, trusted functions delivered by signed Zorid code.
/// The SDK is capability scoped; JavaScriptCore is not a hostile-code sandbox or a hard CPU timeout.
public final class ZoridActionRuntime {
  public static let shared = ZoridActionRuntime()
  private let store: ZoridActionStore

  public init(directoryURL: URL? = nil, legacyDirectoryURL: URL? = nil) {
    store = ZoridActionStore(directoryURL: directoryURL, legacyDirectoryURL: legacyDirectoryURL)
  }

  public func prepareDatabase(legacyDirectory: String?) throws -> String {
    try store.prepare(legacyDirectory: legacyDirectory)
  }

  public func installBundle(_ json: String) throws {
    guard json.utf8.count <= 524_288, let bundle = try actionParse(json) as? [String: Any],
          let appId = bundle["appId"] as? String,
          let version = bundle["version"] as? String, !version.isEmpty, version.utf8.count <= 128,
          let runtimeVersion = bundle["runtimeVersion"] as? NSNumber, runtimeVersion.doubleValue == 1,
          CFGetTypeID(runtimeVersion) != CFBooleanGetTypeID(),
          let capabilities = bundle["capabilities"] as? [String],
          Set(capabilities).count == capabilities.count,
          Set(capabilities).isSubset(of: ["records", "outbox", "surfaces"]),
          let handlers = bundle["handlers"] as? [String: String], !handlers.isEmpty, handlers.count <= 64 else {
      throw ZoridActionError("Unsupported or invalid action bundle.")
    }
    try actionIdentifier(appId, maximum: 64)
    for (actionId, source) in handlers {
      try actionIdentifier(actionId, maximum: 64)
      guard !source.isEmpty, source.utf8.count <= 131_072 else { throw ZoridActionError("Action handler exceeds its size limit.") }
    }
    let database = try store.connect()
    let canonical = try actionJSON(bundle)
    try database.transaction {
      let existing = try database.rows("SELECT manifest FROM zorid_action_bundle_versions WHERE app_id=? AND version=?", [appId, version]).first
        ?? database.rows("SELECT manifest FROM zorid_action_bundles WHERE app_id=? AND version=?", [appId, version]).first
      if let previous = existing?["manifest"] as? String, previous != canonical {
        throw ZoridActionError("Changed action code requires a new bundle version.")
      }
      try database.execute("INSERT OR IGNORE INTO zorid_action_bundle_versions(app_id,version,manifest) VALUES(?,?,?)", [appId, version, canonical])
      try database.execute("INSERT INTO zorid_action_bundles(app_id,version,manifest) VALUES(?,?,?) ON CONFLICT(app_id) DO UPDATE SET version=excluded.version,manifest=excluded.manifest", [appId, version, canonical])
    }
  }

  public func dispatch(_ json: String) throws -> String {
    guard json.utf8.count <= 65_536, let request = try actionParse(json) as? [String: Any],
          let appId = request["appId"] as? String, let actionId = request["actionId"] as? String,
          let invocationId = request["invocationId"] as? String else {
      throw ZoridActionError("Invalid action invocation.")
    }
    try actionIdentifier(appId, maximum: 64)
    try actionIdentifier(actionId, maximum: 64)
    try actionIdentifier(invocationId)
    if let version = request["bundleVersion"], !(version is String) { throw ZoridActionError("Invalid action bundle version.") }
    let canonicalRequest = try actionJSON(request)
    let database = try store.connect()
    var didChangeRecords = false
    let response = try database.transaction {
      if let receipt = try database.rows("SELECT request,response FROM zorid_action_receipts WHERE app_id=? AND invocation_id=?", [appId, invocationId]).first {
        guard receipt["request"] as? String == canonicalRequest else { throw ZoridActionError("This invocation ID belongs to a different action request.") }
        guard var response = try actionParse(receipt["response"] as! String) as? [String: Any] else { throw ZoridActionError("Invalid stored action receipt.") }
        response["duplicate"] = true
        response["effects"] = try effects(database, appId: appId, invocationId: invocationId)
        return try actionJSON(response)
      }
      guard let row = try database.rows("SELECT version,manifest FROM zorid_action_bundles WHERE app_id=?", [appId]).first,
            let manifestJSON = row["manifest"] as? String,
            let manifest = try actionParse(manifestJSON) as? [String: Any],
            let handlers = manifest["handlers"] as? [String: String], let source = handlers[actionId],
            let capabilities = manifest["capabilities"] as? [String] else {
        throw ZoridActionError("The requested app action is not installed.")
      }
      if let requiredVersion = request["bundleVersion"] as? String, requiredVersion != row["version"] as? String {
        throw ZoridActionError("The action belongs to a different app version. Refresh its widget.")
      }
      let execution = ZoridActionExecution(database: database, appId: appId, invocationId: invocationId, capabilities: Set(capabilities))
      let result = try execution.run(source: source, args: request["args"] ?? NSNull())
      didChangeRecords = execution.didChangeRecords
      let response: [String: Any] = ["invocationId": invocationId, "duplicate": false, "result": result, "effects": try effects(database, appId: appId, invocationId: invocationId)]
      // A receipt and every data/outbox/effect write commit together, or all roll back.
      let serialized = try actionJSON(response)
      try database.execute("INSERT INTO zorid_action_receipts(app_id,invocation_id,request,response,created_at) VALUES(?,?,?,?,?)", [appId, invocationId, canonicalRequest, serialized, execution.now])
      return serialized
    }
    if didChangeRecords {
      NotificationCenter.default.post(name: Self.recordsChangedNotification, object: nil, userInfo: ["appId": appId])
    }
    return response
  }

  public static let recordsChangedNotification = Notification.Name("ZoridActionRecordsChanged")

  public func pendingEffects(appId: String) throws -> String {
    try actionIdentifier(appId, maximum: 64)
    return try actionJSON(effects(store.connect(), appId: appId))
  }

  public func acknowledgeEffects(ids: [String]) throws {
    guard ids.count <= 256 else { throw ZoridActionError("Too many effect acknowledgements.") }
    let database = try store.connect()
    try database.transaction {
      for id in ids {
        try actionIdentifier(id)
        try database.execute("DELETE FROM zorid_action_effects WHERE id=?", [id])
      }
    }
  }

  public func readOutbox(appId: String) throws -> String {
    try actionIdentifier(appId, maximum: 64)
    return try actionJSON(store.connect().rows("SELECT id,app_id,type,payload,created_at FROM zorid_action_outbox WHERE app_id=? ORDER BY rowid LIMIT 8", [appId]).map { row in
      ["id": row["id"]!, "appId": row["app_id"]!, "type": row["type"]!, "payload": try actionParse(row["payload"] as! String), "createdAt": row["created_at"]!] as [String: Any]
    })
  }

  public func acknowledgeOutbox(appId: String, ids: [String]) throws {
    try actionIdentifier(appId, maximum: 64)
    guard ids.count <= 256 else { throw ZoridActionError("Too many outbox acknowledgements.") }
    let database = try store.connect()
    try database.transaction {
      for id in ids {
        try actionIdentifier(id)
        try database.execute("DELETE FROM zorid_action_outbox WHERE app_id=? AND id=?", [appId, id])
      }
    }
  }

  private func effects(_ database: ZoridActionConnection, appId: String, invocationId: String? = nil) throws -> [[String: Any]] {
    let query = invocationId == nil
      ? "SELECT id,sequence,payload FROM zorid_action_effects WHERE app_id=? ORDER BY sequence LIMIT 8"
      : "SELECT id,sequence,payload FROM zorid_action_effects WHERE app_id=? AND invocation_id=? ORDER BY sequence"
    return try database.rows(query, invocationId.map { [appId, $0] } ?? [appId]).map { row in
      guard var effect = try actionParse(row["payload"] as! String) as? [String: Any] else { throw ZoridActionError("Invalid stored surface effect.") }
      effect["id"] = row["id"]!
      effect["appId"] = appId
      effect["sequence"] = row["sequence"]!
      return effect
    }
  }
}

private final class ZoridActionExecution {
  let now = floor(Date().timeIntervalSince1970 * 1000)
  private let database: ZoridActionConnection
  private let appId: String
  private let invocationId: String
  private let capabilities: Set<String>
  private weak var context: JSContext?
  private var strictStringify: JSValue?
  private var failure: Error?
  private var operations = 0
  private(set) var didChangeRecords = false

  init(database: ZoridActionConnection, appId: String, invocationId: String, capabilities: Set<String>) {
    self.database = database; self.appId = appId; self.invocationId = invocationId; self.capabilities = capabilities
  }

  func run(source: String, args: Any) throws -> Any {
    guard let context = JSContext(), let sdk = JSValue(newObjectIn: context) else { throw ZoridActionError("Unable to create the action runtime.") }
    self.context = context
    strictStringify = context.evaluateScript("""
      (function(stringify,isFinite){
        return function(value){
          return stringify(value,function(key,item){
            var type=typeof item;
            if(type==='undefined'||type==='function'||type==='symbol'||(type==='number'&&!isFinite(item))) throw 'Invalid action JSON value';
            return item;
          });
        };
      })(JSON.stringify,Number.isFinite)
      """)
    defer { strictStringify = nil }
    sdk.setObject(now, forKeyedSubscript: "now" as NSString)
    let records = JSValue(newObjectIn: context)!
    let get: @convention(block) (JSValue, JSValue, JSValue) -> Any? = { collection, id, expectedVersion in
      self.bridge("records") {
        let collection = try self.identifier(collection), id = try self.identifier(id)
        let expectedVersion = try self.schemaVersion(expectedVersion)
        guard let row = try self.database.rows("SELECT schema_version,data FROM documents WHERE feature=? AND collection=? AND id=?", [self.appId, collection, id]).first else { return NSNull() }
        guard (row["schema_version"] as? NSNumber)?.intValue == expectedVersion else { throw ZoridActionError("Unsupported record schema version. Refresh the app before changing this record.") }
        return try actionParse(row["data"] as! String)
      }
    }
    let list: @convention(block) (JSValue, JSValue) -> Any? = { collection, expectedVersion in
      self.bridge("records") {
        let collection = try self.identifier(collection)
        let expectedVersion = try self.schemaVersion(expectedVersion)
        let total = try self.database.rows("SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM documents WHERE feature=? AND collection=?", [self.appId, collection]).first!
        guard ((total["count"] as? NSNumber)?.intValue ?? 0) <= 1000,
              ((total["bytes"] as? NSNumber)?.intValue ?? 0) <= 1_048_576 else {
          throw ZoridActionError("Action collection exceeds its bounded read limit.")
        }
        let rows = try self.database.rows("SELECT schema_version,data FROM documents WHERE feature=? AND collection=? ORDER BY updated_at DESC,id LIMIT 1001", [self.appId, collection])
        guard rows.count <= 1000 else { throw ZoridActionError("Action collection exceeds the 1,000-record read limit.") }
        return try rows.map {
          guard ($0["schema_version"] as? NSNumber)?.intValue == expectedVersion else { throw ZoridActionError("Unsupported record schema version. Refresh the app before changing this collection.") }
          return try actionParse($0["data"] as! String)
        }
      }
    }
    let put: @convention(block) (JSValue, JSValue, JSValue, JSValue) -> Any? = { collection, id, data, version in
      self.bridge("records") {
        let collection = try self.identifier(collection), id = try self.identifier(id)
        let schemaVersion = try self.schemaVersion(version)
        if let existing = try self.database.rows("SELECT schema_version FROM documents WHERE feature=? AND collection=? AND id=?", [self.appId, collection, id]).first,
           let oldVersion = existing["schema_version"] as? NSNumber, oldVersion.intValue > schemaVersion {
          throw ZoridActionError("An action cannot overwrite a newer record schema with an older version.")
        }
        let json = try self.jsonValue(data)
        guard json.utf8.count <= 65_536 else { throw ZoridActionError("Record exceeds the 64 KiB action limit.") }
        try self.database.execute("INSERT INTO documents(feature,collection,id,schema_version,updated_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(feature,collection,id) DO UPDATE SET schema_version=excluded.schema_version,updated_at=excluded.updated_at,data=excluded.data", [self.appId, collection, id, schemaVersion, self.now, json])
        self.didChangeRecords = true
        return NSNull()
      }
    }
    let delete: @convention(block) (JSValue, JSValue, JSValue) -> Any? = { collection, id, expectedVersion in
      self.bridge("records") {
        let collection = try self.identifier(collection), id = try self.identifier(id)
        let expectedVersion = try self.schemaVersion(expectedVersion)
        if let row = try self.database.rows("SELECT schema_version FROM documents WHERE feature=? AND collection=? AND id=?", [self.appId, collection, id]).first {
          guard (row["schema_version"] as? NSNumber)?.intValue == expectedVersion else { throw ZoridActionError("Unsupported record schema version. Refresh the app before deleting this record.") }
          try self.database.execute("DELETE FROM documents WHERE feature=? AND collection=? AND id=?", [self.appId, collection, id])
          self.didChangeRecords = true
        }
        return NSNull()
      }
    }
    records.setObject(get, forKeyedSubscript: "get" as NSString)
    records.setObject(list, forKeyedSubscript: "list" as NSString)
    records.setObject(put, forKeyedSubscript: "put" as NSString)
    records.setObject(delete, forKeyedSubscript: "delete" as NSString)
    sdk.setObject(records, forKeyedSubscript: "records" as NSString)

    let outbox = JSValue(newObjectIn: context)!
    let enqueue: @convention(block) (JSValue, JSValue) -> Any? = { type, payload in
      self.bridge("outbox") {
        let type = try self.identifier(type)
        let json = try self.jsonValue(payload)
        guard json.utf8.count <= 65_536 else { throw ZoridActionError("Outbox payload exceeds its limit.") }
        let count = try self.database.rows("SELECT count(*) AS count FROM zorid_action_outbox WHERE app_id=?", [self.appId]).first?["count"] as? NSNumber
        guard (count?.intValue ?? 0) < 1000 else { throw ZoridActionError("The app outbox is full. Process pending work before retrying.") }
        let id = UUID().uuidString.lowercased()
        try self.database.execute("INSERT INTO zorid_action_outbox(id,app_id,type,payload,created_at) VALUES(?,?,?,?,?)", [id, self.appId, type, json, self.now])
        return id
      }
    }
    outbox.setObject(enqueue, forKeyedSubscript: "enqueue" as NSString)
    sdk.setObject(outbox, forKeyedSubscript: "outbox" as NSString)

    let surfaces = JSValue(newObjectIn: context)!
    let publish: @convention(block) (JSValue) -> Any? = { effectValue in
      self.bridge("surfaces") {
        let effect = try self.validatedEffect(effectValue)
        let count = try self.database.rows("SELECT count(*) AS count FROM zorid_action_effects WHERE app_id=?", [self.appId]).first?["count"] as? NSNumber
        guard (count?.intValue ?? 0) < 1000 else { throw ZoridActionError("Too many pending surface updates.") }
        let id = UUID().uuidString.lowercased()
        try self.database.execute("INSERT INTO zorid_action_effects(id,app_id,invocation_id,payload,created_at) VALUES(?,?,?,?,?)", [id, self.appId, self.invocationId, try actionJSON(effect), self.now])
        return id
      }
    }
    surfaces.setObject(publish, forKeyedSubscript: "publish" as NSString)
    sdk.setObject(surfaces, forKeyedSubscript: "surfaces" as NSString)

    // Only the trusted function source is evaluated. User arguments are bridged as values.
    guard let handler = context.evaluateScript("(\(source))"), context.exception == nil,
          context.evaluateScript("(function(f){return typeof f === 'function';})")?.call(withArguments: [handler])?.toBool() == true else {
      throw ZoridActionError("The installed action handler is invalid.")
    }
    let result = handler.call(withArguments: [args, sdk])
    if let failure { throw failure }
    guard context.exception == nil else { throw ZoridActionError("The app action failed; no changes were saved.") }
    if let result, !result.isNull, !result.isUndefined,
       context.evaluateScript("(function(value){return value != null && typeof value.then === 'function';})")?.call(withArguments: [result])?.toBool() == true {
      throw ZoridActionError("Action handlers must finish synchronously. Queue deferred work in the outbox.")
    }
    guard context.exception == nil else { throw ZoridActionError("The app action returned an invalid result.") }
    guard let result, !result.isUndefined else { return NSNull() }
    return try actionParse(jsonValue(result))
  }

  private func bridge(_ capability: String, _ operation: () throws -> Any) -> Any? {
    do {
      if failure != nil { throw ZoridActionError("The action has already failed.") }
      guard capabilities.contains(capability) else { throw ZoridActionError("The app action lacks the \(capability) capability.") }
      operations += 1
      guard operations <= 256 else { throw ZoridActionError("Action exceeds its 256-operation limit.") }
      return try operation()
    } catch {
      if failure == nil { failure = error }
      if let context { context.exception = JSValue(newErrorFromMessage: "Action capability failed.", in: context) }
      return nil
    }
  }

  private func identifier(_ value: JSValue) throws -> String {
    guard value.isString, let text = value.toString() else { throw ZoridActionError("Expected an action identifier.") }
    try actionIdentifier(text)
    return text
  }

  private func schemaVersion(_ value: JSValue) throws -> Int {
    let version = value.isUndefined ? 1.0 : value.toDouble()
    guard value.isUndefined || value.isNumber, version.isFinite, version >= 1, version <= 1_000_000, version.rounded() == version else {
      throw ZoridActionError("Invalid record schema version.")
    }
    return Int(version)
  }

  private func jsonValue(_ value: JSValue) throws -> String {
    guard let context, let serialized = strictStringify?.call(withArguments: [value]),
          context.exception == nil, serialized.isString, let json = serialized.toString(), json.utf8.count <= 1_048_576 else {
      throw ZoridActionError("Action values must be finite, JSON-serializable data.")
    }
    _ = try actionParse(json)
    return json
  }

  private func widgetValue(_ value: Any) -> Bool {
    if value is NSNull { return false }
    if let object = value as? [String: Any] { return object.values.allSatisfy(widgetValue) }
    if let array = value as? [Any] { return array.allSatisfy(widgetValue) }
    return value is String || value is NSNumber
  }

  private func validatedEffect(_ value: JSValue) throws -> [String: Any] {
    guard let effect = try actionParse(jsonValue(value)) as? [String: Any],
          let props = effect["props"] as? [String: Any],
          effect.keys.allSatisfy({ ["widget", "activity", "props", "startActivity", "endActivity", "url", "staleAt", "timeline"].contains($0) }) else {
      throw ZoridActionError("Invalid surface effect.")
    }
    var hasTarget = false
    for target in ["widget", "activity"] {
      if let name = effect[target] {
        guard let name = name as? String else { throw ZoridActionError("Invalid surface name.") }
        try actionIdentifier(name)
        hasTarget = true
      }
    }
    guard hasTarget else { throw ZoridActionError("A surface effect needs a widget or activity target.") }
    if effect["widget"] != nil, !widgetValue(props) {
      throw ZoridActionError("Widget props cannot contain null values.")
    }
    if effect["activity"] != nil, try actionJSON(props).utf8.count > 3_072 { throw ZoridActionError("Live Activity content exceeds its action limit.") }
    for flag in ["startActivity", "endActivity"] {
      if let value = effect[flag] {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID(), effect["activity"] != nil else { throw ZoridActionError("Invalid activity lifecycle policy.") }
      }
    }
    guard !((effect["startActivity"] as? Bool == true) && (effect["endActivity"] as? Bool == true)) else { throw ZoridActionError("A surface effect cannot start and end an activity together.") }
    if let value = effect["url"] {
      guard let url = value as? String, url.utf8.count <= 4096,
            let components = URLComponents(string: url), components.scheme?.lowercased() == "zorid",
            components.user == nil, components.password == nil, effect["activity"] != nil else { throw ZoridActionError("Invalid Live Activity route.") }
    }
    if let value = effect["staleAt"] {
      guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw ZoridActionError("Invalid surface stale date.") }
    }
    if let value = effect["timeline"] {
      guard let timeline = value as? [[String: Any]], !timeline.isEmpty, timeline.count <= 32 else { throw ZoridActionError("Invalid widget timeline.") }
      var previous = -Double.infinity
      for entry in timeline {
        guard let date = entry["date"] as? NSNumber, CFGetTypeID(date) != CFBooleanGetTypeID(), date.doubleValue.isFinite,
              date.doubleValue >= previous, entry["props"] is [String: Any] else { throw ZoridActionError("Invalid widget timeline entry.") }
        if effect["widget"] != nil, !widgetValue(entry["props"]!) {
          throw ZoridActionError("Widget timeline props cannot contain null values.")
        }
        previous = date.doubleValue
      }
    }
    guard try actionJSON(effect).utf8.count <= 65_536 else { throw ZoridActionError("Surface effect exceeds its size limit.") }
    return effect
  }
}
