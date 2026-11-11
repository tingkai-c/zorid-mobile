import Foundation
import CoreFoundation

@main
enum NotificationChecks {
  static var checks = 0
  static func check(_ value: Bool, _ name: String) {
    checks += 1
    if !value { fatalError("Notification regression failed: \(name)") }
  }
  static func rejects(_ operation: () throws -> Void, _ name: String) {
    do { try operation(); fatalError("Notification regression did not reject: \(name)") }
    catch { checks += 1 }
  }
  static func receipt(appId: String = "demo", text: String? = nil) -> [String: Any] {
    var value: [String: Any] = ["id": UUID().uuidString, "appId": appId,
      "notificationId": "session-1", "actionId": "done", "receivedAt": 1_800_000_000_000,
      "data": ["nullable": NSNull(), "values": [true, 1, "text"]] as [String: Any]]
    if let text { value["text"] = text }
    return value
  }

  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("zorid-notifications-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let data: [String: Any] = ["nullable": NSNull(), "nested": ["array": [NSNull(), true, 1, 1.5, "文字"]], "bool": true, "number": 1]
    let packed = try ZoridNotificationPayload.pack(appId: "demo", id: "session-1", data: data)
    let plist = try PropertyListSerialization.data(fromPropertyList: packed, format: .binary, options: 0)
    let reloaded = try PropertyListSerialization.propertyList(from: plist, options: [], format: nil) as! [AnyHashable: Any]
    let unpacked = ZoridNotificationPayload.unpack(reloaded, requestIdentifier: "zorid.device.notification:demo:session-1")
    check(unpacked != nil && unpacked?.appId == "demo" && unpacked?.id == "session-1", "property-list-safe envelope")
    check(unpacked?.data["nullable"] is NSNull, "JSON null survives property-list transport")
    let nested = unpacked?.data["nested"] as? [String: Any]
    let array = nested?["array"] as? [Any]
    check(array?.count == 5 && array?[0] is NSNull && array?[4] as? String == "文字", "nested array and UTF-8 survive")
    check(CFGetTypeID(unpacked!.data["bool"] as! NSNumber) == CFBooleanGetTypeID(), "Boolean type retained")
    check(CFGetTypeID(unpacked!.data["number"] as! NSNumber) != CFBooleanGetTypeID(), "number distinct from Boolean")
    check(ZoridNotificationPayload.unpack(packed, requestIdentifier: "zorid.device.notification:other:session-1") == nil, "other app marker rejected")
    check(ZoridNotificationPayload.unpack(packed, requestIdentifier: "unrelated") == nil, "unrelated notification ignored")
    check(ZoridNotificationPayload.unpack(["data": data], requestIdentifier: "zorid.device.notification:demo:session-1") == nil, "unknown unmarked payload ignored")
    var malformed = packed
    malformed[ZoridNotificationPayload.dataKey] = "[null,true]"
    check(ZoridNotificationPayload.unpack(malformed, requestIdentifier: "zorid.device.notification:demo:session-1") == nil, "array root rejected")
    malformed[ZoridNotificationPayload.dataKey] = "{invalid"
    check(ZoridNotificationPayload.unpack(malformed, requestIdentifier: "zorid.device.notification:demo:session-1") == nil, "malformed JSON rejected")
    malformed[ZoridNotificationPayload.dataKey] = true
    check(ZoridNotificationPayload.unpack(malformed, requestIdentifier: "zorid.device.notification:demo:session-1") == nil, "non-string transport rejected")
    rejects({ _ = try ZoridNotificationPayload.pack(appId: "demo:other", id: "id", data: [:]) }, "namespace injection")
    rejects({ _ = try ZoridNotificationPayload.pack(appId: "demo", id: "id", data: ["text": String(repeating: "界", count: 6000)]) }, "UTF-8 data budget")
    rejects({ _ = try ZoridNotificationPayload.pack(appId: "demo", id: "id", data: ["invalid": Double.nan]) }, "non-JSON number")

    let url = root.appendingPathComponent("normal/receipts.json")
    let store = ZoridNotificationResponseStore(url: url)
    let first = receipt()
    let other = receipt(appId: "other")
    store.append(first); store.append(other)
    check(!store.persistenceError && store.pending(appId: "demo").count == 1, "native receipt persisted")
    check(store.pending(appId: "demo").first?["appId"] == nil, "internal namespace hidden")
    check(ZoridNotificationResponseStore(url: url).pending(appId: "other").count == 1, "receipt survives process store reload")
    try store.acknowledge(appId: "demo", ids: [other["id"] as! String])
    check(store.pending(appId: "other").count == 1, "ack cannot remove another namespace")
    try store.acknowledge(appId: "demo", ids: [first["id"] as! String])
    check(store.pending(appId: "demo").isEmpty && store.pending(appId: "other").count == 1, "ack commits only matching receipt")
    let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber
    check(mode.intValue & 0o777 == 0o600, "response file private mode")

    let corruptURL = root.appendingPathComponent("recovery/receipts.json")
    let seed = ZoridNotificationResponseStore(url: corruptURL)
    let older = receipt()
    seed.append(older)
    let saved = try Data(contentsOf: corruptURL)
    let broken = Data("{invalid".utf8)
    try broken.write(to: corruptURL)
    let retry = ZoridNotificationResponseStore(url: corruptURL)
    check(retry.pending(appId: "demo").isEmpty && retry.persistenceError, "unreadable queue reported")
    let newer = receipt()
    retry.append(newer)
    check(try Data(contentsOf: corruptURL) == broken, "new callback cannot overwrite unread older file")
    check(retry.pending(appId: "demo").count == 1 && retry.persistenceError, "new callback retained during read failure")
    rejects({ try retry.acknowledge(appId: "demo", ids: [newer["id"] as! String]) }, "unread queue cannot acknowledge")
    try saved.write(to: corruptURL)
    check(retry.pending(appId: "demo").count == 2 && !retry.persistenceError, "retry merges old disk and new memory receipts")
    check(ZoridNotificationResponseStore(url: corruptURL).pending(appId: "demo").count == 2, "merged recovery is durable")

    let failDirectory = root.appendingPathComponent("ack-failure", isDirectory: true)
    let failURL = failDirectory.appendingPathComponent("receipts.json")
    let failStore = ZoridNotificationResponseStore(url: failURL)
    let unacked = receipt()
    failStore.append(unacked)
    let backup = root.appendingPathComponent("ack-backup", isDirectory: true)
    try FileManager.default.moveItem(at: failDirectory, to: backup)
    _ = FileManager.default.createFile(atPath: failDirectory.path, contents: Data())
    rejects({ try failStore.acknowledge(appId: "demo", ids: [unacked["id"] as! String]) }, "failed durable ack")
    check(failStore.pending(appId: "demo").count == 1 && failStore.persistenceError, "failed ack retains callback")
    try FileManager.default.removeItem(at: failDirectory)
    try FileManager.default.moveItem(at: backup, to: failDirectory)
    try failStore.acknowledge(appId: "demo", ids: [unacked["id"] as! String])
    check(ZoridNotificationResponseStore(url: failURL).pending(appId: "demo").isEmpty, "ack retry clears only after save")

    let boundedURL = root.appendingPathComponent("bounded/receipts.json")
    let bounded = ZoridNotificationResponseStore(url: boundedURL)
    for _ in 0..<130 { bounded.append(receipt()) }
    check(bounded.pending(appId: "demo").count == 128 && bounded.overflowed, "count budget reports overflow")
    let bytesURL = root.appendingPathComponent("byte-budget/receipts.json")
    let bytesStore = ZoridNotificationResponseStore(url: bytesURL)
    for _ in 0..<70 { bytesStore.append(receipt(text: String(repeating: "x", count: 65_536))) }
    check(bytesStore.overflowed && !bytesStore.persistenceError, "byte budget reports deliberate oldest eviction")
    check(try Data(contentsOf: bytesURL).count <= ZoridNotificationResponseStore.byteLimit, "response file byte budget")
    print("Notification payload/receipt store checks passed: \(checks)")
  }
}
