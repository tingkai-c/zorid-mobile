import Foundation

@main struct ScreenTimePlanTests {
  static func main() throws {
    var checks = 0
    func check(_ value: Bool) { precondition(value); checks += 1 }
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    for seconds in [1.0, 59.0, 899.0, 900.0, 1500.0, 86400.0] {
      let deadline = now.addingTimeInterval(seconds)
      let interval = try ZoridScreenTimePlan.interval(now: now, endsAt: deadline.timeIntervalSince1970 * 1000)
      check(interval.duration >= 900)
      check(interval.start <= now)
      check(interval.end == deadline)
    }
    for value in [Double.nan, .infinity, -.infinity, 0, -1, now.timeIntervalSince1970 * 1000,
                  now.addingTimeInterval(86401).timeIntervalSince1970 * 1000, now.timeIntervalSince1970 * 1000 + 0.5] {
      do { _ = try ZoridScreenTimePlan.interval(now: now, endsAt: value); preconditionFailure("Invalid deadline accepted") }
      catch ZoridScreenTimeError.invalidDeadline { checks += 1 }
    }
    for value in ["focus", "my-tool.1", "A_B-42", String(repeating: "x", count: 64)] {
      try ZoridScreenTimePlan.identifier(value); checks += 1
    }
    for value in ["", "../secret", "hello world", "a/b", String(repeating: "x", count: 65)] {
      do { try ZoridScreenTimePlan.identifier(value); preconditionFailure("Invalid identifier accepted") }
      catch ZoridScreenTimeError.invalidIdentifier { checks += 1 }
    }
    print("Screen Time interval/identifier checks passed: \(checks)")
  }
}
