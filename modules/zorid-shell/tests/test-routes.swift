import Foundation

@main
struct ZoridRouteChecks {
  static func require(_ condition: Bool, _ message: String) {
    precondition(condition, message)
  }

  static func main() throws {
    let url = "zorid://apps/productivity/tasks?filter=today"
    guard let route = ZoridRoute.parse(url) else { fatalError("Valid app route rejected") }
    require(route.appId == "productivity" && route.path == ["tasks"] && route.query == ["filter": "today"], "Route data changed")
    for invalid in ["zorid://focus", "zorid://pair?token=x", "https://apps/productivity/focus",
      "zorid://user@apps/productivity/focus", "zorid://apps:99/productivity/focus",
      "zorid://apps/productivity/../other", "zorid://apps/productivity/%2e%2e/other",
      "zorid://apps/productivity/a%2fb", "zorid://apps/productivity/a%5cb",
      "zorid://apps/productivity//focus", "zorid://apps/productivity/%",
      "zorid://apps/productivity/%GG", "zorid://apps/productivity/%FF",
      "zorid://apps/productivity/focus?a=1&a=2", "zorid://apps/productivity/focus?=x",
      "zorid://apps/productivity/focus?a=%00", "zorid://apps/productivity/focus#action"] {
      require(ZoridRoute.parse(invalid) == nil, "Invalid app route accepted")
    }

    let suite = "zorid-route-test-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let queue = ZoridRouteQueue(defaults: defaults)
    require(queue.enqueue(url), "Destination was not queued")
    require(!queue.enqueue("zorid://pair?token=x"), "Pairing URL entered app queue")
    let restored = ZoridRouteQueue(defaults: defaults)
    let pending = try JSONDecoder().decode([ZoridRoute].self, from: Data(restored.pending().utf8))
    require(pending.count == 1 && pending[0].url == url, "Destination did not survive a new queue instance")
    restored.acknowledge("unrelated")
    require(try JSONDecoder().decode([ZoridRoute].self, from: Data(queue.pending().utf8)).count == 1, "Wrong acknowledgment consumed destination")
    restored.acknowledge(pending[0].id)
    require(try queue.pending() == "[]", "Acknowledged destination remains queued")
    for index in 0..<35 { require(queue.enqueue("zorid://apps/productivity/tasks?index=\(index)", source: "quickAction"), "Quick action destination rejected") }
    let bounded = try JSONDecoder().decode([ZoridRoute].self, from: Data(queue.pending().utf8))
    require(bounded.count == 32 && bounded.first?.query["index"] == "3" && bounded.last?.source == "quickAction", "Queue bound or source changed")

    let json = """
    [{"id":"tasks","title":"Open Tasks","systemImage":"checklist","url":"zorid://apps/productivity/tasks"}]
    """
    require(try ZoridQuickAction.decode(appId: "productivity", json: json).count == 1, "Valid quick action rejected")
    for invalidJSON in [json.replacingOccurrences(of: "\"id\":\"tasks\"", with: "\"id\":\"settings\""),
      json.replacingOccurrences(of: "apps/productivity", with: "apps/other"),
      json.replacingOccurrences(of: "Open Tasks", with: "   ")] {
      do { _ = try ZoridQuickAction.decode(appId: "productivity", json: invalidJSON); fatalError("Invalid quick action accepted") }
      catch is ZoridRouteError {}
    }
    print("Native route parsing, persisted queue and quick-action checks passed")
  }
}
