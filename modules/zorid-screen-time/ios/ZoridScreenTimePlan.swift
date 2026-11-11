import Foundation

// Foundation-only planning/validation shared by the app, monitor and runner tests.
public enum ZoridScreenTimePlan {
  public static let minimumInterval: TimeInterval = 15 * 60
  public static let maximumDuration: TimeInterval = 24 * 60 * 60

  public static func identifier(_ value: String) throws {
    guard !value.isEmpty, value.utf8.count <= 64,
          value.range(of: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$", options: .regularExpression) != nil else {
      throw ZoridScreenTimeError.invalidIdentifier
    }
  }

  public static func interval(now: Date, endsAt: Double) throws -> DateInterval {
    guard endsAt.isFinite, endsAt > 0, endsAt.rounded() == endsAt else {
      throw ZoridScreenTimeError.invalidDeadline
    }
    let deadline = Date(timeIntervalSince1970: endsAt / 1000)
    let remaining = deadline.timeIntervalSince(now)
    guard endsAt.isFinite, remaining > 0, remaining <= maximumDuration else {
      throw ZoridScreenTimeError.invalidDeadline
    }
    // DeviceActivity accepts ongoing intervals. Backdate short remaining sessions
    // instead of scheduling a <15-minute interval. Real-device expiry acceptance
    // remains required; callbacks occur when the device is in use, not per-second.
    let start = min(now, deadline.addingTimeInterval(-minimumInterval - 1))
    return DateInterval(start: start, end: deadline)
  }
}

public enum ZoridScreenTimeError: LocalizedError {
  case invalidIdentifier, invalidMode, invalidDeadline, unavailableStorage, unavailableAuthorization,
       invalidCommand, invalidSelection, tooManyPolicies, policyMissing, policyActive, monitoringFailed, busy

  public var errorDescription: String? {
    switch self {
    case .invalidIdentifier: return "Invalid Screen Time identifier."
    case .invalidMode: return "Choose blocklist or allowlist."
    case .invalidDeadline: return "The blocking deadline must be within the next 24 hours."
    case .unavailableStorage: return "Shared Screen Time storage is unavailable."
    case .unavailableAuthorization: return "Allow Zorid Screen Time access before blocking apps."
    case .invalidCommand: return "Invalid Screen Time command."
    case .invalidSelection: return "Select up to 50 apps. Allowlist mode supports individual apps only."
    case .tooManyPolicies: return "Save at most 16 Screen Time policies per tool."
    case .policyMissing: return "Choose apps for this blocking policy first."
    case .policyActive: return "Pause blocking before changing this policy."
    case .monitoringFailed: return "Automatic unblock could not be scheduled. App blocking was cleared."
    case .busy: return "Another Screen Time change is in progress. Try again."
    }
  }
}
