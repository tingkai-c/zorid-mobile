import Foundation
import CoreFoundation

// One app process owns this store. Callers serialize access on the main queue.
// The file is never replaced until it was successfully read or did not exist.
final class ZoridNotificationResponseStore {
  static let countLimit = 128
  static let byteLimit = 4_194_304
  private let url: URL
  private var loaded = false
  private var queue: [[String: Any]] = []
  private(set) var persistenceError = false
  private(set) var overflowed = false

  enum Failure: LocalizedError {
    case storage
    var errorDescription: String? { "Notification responses could not be read or saved." }
  }

  init(url: URL) { self.url = url }

  func pending(appId: String) -> [[String: Any]] {
    _ = load()
    if loaded, persistenceError { try? persist(queue) }
    return queue.filter { $0["appId"] as? String == appId }.map { item in
      var item = item; item.removeValue(forKey: "appId"); return item
    }
  }

  func append(_ item: [String: Any]) {
    _ = load()
    queue.append(item)
    trimCount()
    do { try trimBytes() } catch { persistenceError = true }
    // Retain new callbacks in memory and retry loading on the next operation.
    // A locked/unreadable/corrupt file must not erase older unread callbacks.
    guard loaded else { persistenceError = true; return }
    do {
      try persist(queue)
    } catch { persistenceError = true }
  }

  func acknowledge(appId: String, ids: Set<String>) throws {
    guard load() else { throw Failure.storage }
    let replacement = queue.filter { !($0["appId"] as? String == appId && ids.contains($0["id"] as? String ?? "")) }
    try persist(replacement)
    queue = replacement
  }

  private func load() -> Bool {
    if loaded { return true }
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
            let size = attributes[.size] as? NSNumber, size.intValue <= Self.byteLimit else { throw Failure.storage }
      let bytes = try Data(contentsOf: url)
      guard bytes.count <= Self.byteLimit,
            let envelope = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            let version = envelope["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
            let saved = envelope["responses"] as? [[String: Any]], saved.count <= Self.countLimit,
            saved.allSatisfy(Self.valid),
            let overflow = envelope["overflowed"] as? NSNumber, CFGetTypeID(overflow) == CFBooleanGetTypeID() else { throw Failure.storage }
      // A failed earlier read may already have accumulated new native callbacks.
      var known = Set(saved.compactMap { $0["id"] as? String })
      queue = saved + queue.filter { known.insert($0["id"] as? String ?? "").inserted }
      overflowed = overflowed || overflow.boolValue
      trimCount()
      try trimBytes()
      loaded = true
      try persist(queue)
      return true
    } catch {
      let error = error as NSError
      if !loaded, error.domain == NSCocoaErrorDomain,
         error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError {
        loaded = true
        return true
      }
      persistenceError = true
      return false
    }
  }

  private func trimCount() {
    if queue.count > Self.countLimit {
      queue.removeFirst(queue.count - Self.countLimit)
      overflowed = true
    }
  }

  private func trimBytes() throws {
    while try encoded(queue).count > Self.byteLimit, queue.count > 1 {
      queue.removeFirst(); overflowed = true
    }
  }

  private static func valid(_ item: [String: Any]) -> Bool {
    let allowed: Set<String> = ["id", "appId", "notificationId", "actionId", "data", "receivedAt", "text", "textTruncated"]
    guard Set(item.keys).isSubset(of: allowed), let id = item["id"] as? String, UUID(uuidString: id) != nil,
          ZoridNotificationPayload.identifier(item["appId"], max: 64) != nil,
          ZoridNotificationPayload.identifier(item["notificationId"], max: 128) != nil,
          ZoridNotificationPayload.identifier(item["actionId"], max: 128) != nil,
          let receivedAt = item["receivedAt"] as? NSNumber, CFGetTypeID(receivedAt) != CFBooleanGetTypeID(),
          receivedAt.doubleValue.isFinite, receivedAt.doubleValue > 0,
          let data = item["data"] as? [String: Any], JSONSerialization.isValidJSONObject(data),
          (try? JSONSerialization.data(withJSONObject: data).count).map({ $0 <= ZoridNotificationPayload.dataLimit }) == true else { return false }
    if let text = item["text"], !(text is String) { return false }
    if let raw = item["textTruncated"] {
      guard let flag = raw as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { return false }
    }
    return true
  }

  private func encoded(_ items: [[String: Any]]) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["version": 1, "responses": items, "overflowed": overflowed], options: [.sortedKeys])
  }

  private func persist(_ items: [[String: Any]]) throws {
    do {
      guard loaded else { throw Failure.storage }
      let data = try encoded(items)
      guard data.count <= Self.byteLimit else { throw Failure.storage }
      let directory = url.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      #if os(iOS)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      #else
      try data.write(to: url, options: [.atomic])
      #endif
      // Directory protection is established before the atomic commit. A later
      // chmod failure must not turn an already committed acknowledgement into
      // a reported failed transaction.
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      persistenceError = false
    } catch { persistenceError = true; throw Failure.storage }
  }
}
