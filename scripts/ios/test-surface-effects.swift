import Foundation

private enum FixtureError: Error { case rejectedActivity, rejectedWidget, rejectedCheckpoint, rejectedAcknowledgement }
private struct TestFailure: Error, CustomStringConvertible {
  let description: String
}
private func expect(_ condition: Bool, _ message: String) throws {
  if !condition { throw TestFailure(description: message) }
}
private func effect(_ sequence: Int, widget: Bool = true, activity: Bool = true) -> [String: Any] {
  var payload: [String: Any] = ["id": "effect-\(sequence)", "appId": "test-app", "sequence": sequence,
                                "props": ["sequence": sequence]]
  if widget { payload["widget"] = "TestWidget" }
  if activity { payload["activity"] = "TestActivity" }
  return payload
}

private final class Fixture {
  var pending: [[String: Any]]
  var checkpoints: [String: Int64] = [:]
  var widgets: [Int64] = []
  var activities: [Int64] = []
  var acknowledged: [String] = []
  var fetches: [Int64] = []
  var rejectWidget: (Int64) -> Bool = { _ in false }
  var rejectActivity: (Int64) -> Bool = { _ in false }
  var rejectSaveCount = 0
  var rejectAcknowledgementCount = 0

  init(_ effects: [[String: Any]]) { pending = effects }

  func flush() async throws -> Int {
    try await ZoridSurfaceEffectQueue.flush(
      appId: "test-app", initialCheckpoints: checkpoints,
      fetch: { cursor in
        self.fetches.append(cursor)
        return Array(self.pending.filter { ($0["sequence"] as! NSNumber).int64Value > cursor }.prefix(8))
      },
      applyWidget: { item in
        if self.rejectWidget(item.sequence) { throw FixtureError.rejectedWidget }
        self.widgets.append(item.sequence)
      },
      applyActivity: { item in
        if self.rejectActivity(item.sequence) { throw FixtureError.rejectedActivity }
        self.activities.append(item.sequence)
      },
      saveCheckpoints: { next in
        if self.rejectSaveCount > 0 { self.rejectSaveCount -= 1; throw FixtureError.rejectedCheckpoint }
        self.checkpoints = next
      },
      acknowledge: { ids in
        if self.rejectAcknowledgementCount > 0 {
          self.rejectAcknowledgementCount -= 1
          throw FixtureError.rejectedAcknowledgement
        }
        self.acknowledged.append(contentsOf: ids)
        self.pending.removeAll { ids.contains($0["id"] as! String) }
      }
    )
  }
}

@main
struct SurfaceEffectChecks {
  static func main() async throws {
    // Regression: an old rejected background start cannot block a later pause.
    let superseded = Fixture([effect(1), effect(2)])
    superseded.rejectActivity = { $0 == 1 }
    try expect(try await superseded.flush() == 2, "superseded failed start must be acknowledged")
    try expect(superseded.widgets == [1, 2], "later widget update must apply despite an earlier activity failure")
    try expect(superseded.activities == [2], "later activity state must supersede the failed start")
    try expect(superseded.pending.isEmpty, "obsolete failed start must not remain pending")

    // The cursor skips more than one failed native page instead of refetching it.
    let paginated = Fixture((1...12).map { effect($0) } + [effect(13, activity: false)])
    paginated.rejectActivity = { _ in true }
    do { _ = try await paginated.flush(); throw TestFailure(description: "unresolved activities must report an error") }
    catch FixtureError.rejectedActivity { }
    try expect(paginated.widgets.last == 13, "failure in the first eight effects must not starve later widgets")
    try expect(paginated.pending.count == 12, "only failed activity effects must remain")
    try expect(paginated.fetches.contains(8), "pagination must advance beyond the first failed page")

    // Bounded work must still advance across invocations when >32 failures exist.
    let bounded = Fixture((1...40).map { effect($0, widget: false) } + [effect(41, activity: false)])
    bounded.rejectActivity = { _ in true }
    do { _ = try await bounded.flush() } catch FixtureError.rejectedActivity { }
    try expect(bounded.checkpoints["cursor:test-app"] == 32, "persist continuation after bounded work")
    do { _ = try await bounded.flush() } catch FixtureError.rejectedActivity { }
    try expect(bounded.widgets == [41], "newer widgets must eventually pass more than32 failing effects")

    // Independent widget failure still lets an activity update, then becomes stale.
    let independent = Fixture([effect(1), effect(2, activity: false)])
    independent.rejectWidget = { $0 == 1 }
    try expect(try await independent.flush() == 2, "newer widget must supersede old widget failure")
    try expect(independent.activities == [1], "widget error must not block same-effect activity")

    // Checkpoint failure preserves work until a later successful write supersedes it.
    let checkpoint = Fixture([effect(1), effect(2, activity: false)])
    checkpoint.rejectSaveCount = 1
    try expect(try await checkpoint.flush() == 2, "later durable checkpoint must resolve failed earlier checkpoint")
    try expect(checkpoint.checkpoints["widget:TestWidget"] == 2, "latest checkpoint must be durable before acknowledgement")

    let acknowledgement = Fixture([effect(1, activity: false)])
    acknowledgement.rejectAcknowledgementCount = 1
    try expect(try await acknowledgement.flush() == 1, "acknowledgement failure must retry without duplicate surface application")
    try expect(acknowledgement.widgets == [1], "acknowledgement retry must not replay already checkpointed widget")

    // Extension deferral is recoverable from a later app-process flush.
    let deferred = Fixture([effect(1)])
    deferred.rejectActivity = { _ in true }
    do { _ = try await deferred.flush() } catch FixtureError.rejectedActivity { }
    try expect(deferred.pending.count == 1 && deferred.widgets == [1], "deferred activity must keep committed widget state")
    deferred.rejectActivity = { _ in false }
    try expect(try await deferred.flush() == 1, "app context must complete deferred effect")
    try expect(deferred.widgets == [1] && deferred.activities == [1], "foreground retry must skip checkpointed widget")

    let stale = Fixture([effect(1)])
    stale.checkpoints = ["widget:TestWidget": 10, "activity:TestActivity": 10]
    try expect(try await stale.flush() == 1, "stale effects should acknowledge without applying old state")
    try expect(stale.widgets.isEmpty && stale.activities.isEmpty, "stale effects must not overwrite newer state")
    print("8 native surface-effect regression checks passed")
  }
}
