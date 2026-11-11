import Foundation

struct ZoridRoute: Codable {
  let id: String
  let appId: String
  let path: [String]
  let query: [String: String]
  let url: String
  let source: String
  let receivedAt: Double

  static func validIdentifier(_ value: String) -> Bool {
    value.range(of: "^[a-z0-9][a-z0-9._-]{0,63}$", options: .regularExpression) != nil
  }

  static func parse(_ value: String, source: String = "link") -> ZoridRoute? {
    guard value.utf8.count <= 4096,
      source == "link" || source == "quickAction",
      let components = URLComponents(string: value),
      components.scheme?.lowercased() == "zorid", components.host == "apps",
      components.user == nil, components.password == nil, components.port == nil,
      components.fragment == nil,
      value.range(of: "%((?![0-9a-fA-F]{2}).|$)", options: .regularExpression) == nil,
      value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
      !value.contains("\\"),
      !components.percentEncodedPath.contains("//") else { return nil }
    var segments: [String] = []
    for encoded in components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true) {
      guard let segment = String(encoded).removingPercentEncoding,
        !segment.isEmpty, segment != ".", segment != "..",
        segment.utf8.count <= 256, !segment.contains("/"), !segment.contains("\\"),
        segment.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return nil }
      segments.append(segment)
    }
    guard let appId = segments.first, validIdentifier(appId), segments.count <= 17 else { return nil }
    var query: [String: String] = [:]
    let items = components.queryItems ?? []
    guard items.count <= 16 else { return nil }
    for item in items {
      guard !item.name.isEmpty, item.name.utf8.count <= 64, query[item.name] == nil,
        (item.value ?? "").utf8.count <= 512,
        !item.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
        !(item.value ?? "").unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
      query[item.name] = item.value ?? ""
    }
    return ZoridRoute(id: UUID().uuidString, appId: appId, path: Array(segments.dropFirst()),
      query: query, url: value, source: source, receivedAt: Date().timeIntervalSince1970 * 1000)
  }
}

enum ZoridRouteError: LocalizedError {
  case invalid(String)
  var errorDescription: String? {
    switch self { case .invalid(let message): return message }
  }
}

/// Acknowledgment follows successful JS handling, so setup, OTA reloads and a
/// temporarily absent downloaded app don't consume a destination prematurely.
final class ZoridRouteQueue {
  static let shared = ZoridRouteQueue()
  static let changed = Notification.Name("ZoridRouteQueueChanged")
  private let defaults: UserDefaults
  private let key = "zorid.pending-routes.v1"
  private let lock = NSRecursiveLock()

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  @discardableResult
  func enqueue(_ value: String, source: String = "link") -> Bool {
    guard let route = ZoridRoute.parse(value, source: source) else { return false }
    lock.lock()
    var routes = read()
    // Preserve the most recent user destinations if no downloaded app handles
    // links for an extended period. The queue is intentionally bounded.
    if routes.count >= 32 { routes.removeFirst(routes.count - 31) }
    routes.append(route)
    save(routes)
    lock.unlock()
    NotificationCenter.default.post(name: Self.changed, object: nil)
    return true
  }

  func pending() throws -> String {
    lock.lock(); defer { lock.unlock() }
    let data = try JSONEncoder().encode(read())
    return String(decoding: data, as: UTF8.self)
  }

  func acknowledge(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    save(read().filter { $0.id != id })
  }

  private func read() -> [ZoridRoute] {
    guard let data = defaults.data(forKey: key) else { return [] }
    return (try? JSONDecoder().decode([ZoridRoute].self, from: data)) ?? []
  }

  private func save(_ routes: [ZoridRoute]) {
    // ZoridRoute contains only Codable values; an encoding failure is impossible
    // for validated input, but preserve the prior queue if one ever occurs.
    if let data = try? JSONEncoder().encode(routes) { defaults.set(data, forKey: key) }
  }
}

struct ZoridQuickAction: Codable {
  let id: String
  let title: String
  let subtitle: String?
  let systemImage: String?
  let url: String

  static func decode(appId: String, json: String) throws -> [ZoridQuickAction] {
    guard ZoridRoute.validIdentifier(appId), json.utf8.count <= 16_384,
      let data = json.data(using: .utf8),
      let items = try? JSONDecoder().decode([ZoridQuickAction].self, from: data), items.count <= 3 else {
      throw ZoridRouteError.invalid("Provide an app ID and up to three valid quick actions.")
    }
    var ids = Set<String>()
    for item in items {
      guard ZoridRoute.validIdentifier(item.id), item.id != "settings", ids.insert(item.id).inserted,
        validText(item.title, maximum: 80),
        item.subtitle == nil || validText(item.subtitle!, maximum: 120),
        item.systemImage == nil || item.systemImage!.range(of: "^[a-z0-9][a-z0-9._-]{0,79}$", options: .regularExpression) != nil,
        let route = ZoridRoute.parse(item.url), route.appId == appId else {
        throw ZoridRouteError.invalid("Quick actions need unique IDs, readable labels and a route belonging to their app.")
      }
    }
    return items
  }

  private static func validText(_ value: String, maximum: Int) -> Bool {
    !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= maximum &&
      value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
  }
}
