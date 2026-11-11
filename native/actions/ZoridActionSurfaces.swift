import Foundation
import Darwin
import WidgetKit
import ActivityKit
import ZoridActions

private enum ZoridSurfaceError: LocalizedError {
  case invalidTarget, invalidEffect, unavailableStorage, busy, activityRequiresApp, oversizedActivity, morePending, liveActivitiesUnavailable

  var errorDescription: String? {
    switch self {
    case .invalidTarget: return "The widget action is invalid."
    case .invalidEffect: return "The saved surface update is invalid."
    case .unavailableStorage: return "Shared widget storage is unavailable."
    case .busy: return "Another surface update is in progress. Please try again."
    case .activityRequiresApp: return "Your change is saved. Open Zorid to refresh the Live Activity."
    case .oversizedActivity: return "The Live Activity update exceeds its data limit."
    case .morePending: return "Your changes are saved. More surface updates remain; refresh again."
    case .liveActivitiesUnavailable: return "Live Activities are disabled. Your changes are saved."
    }
  }
}

// Compiled inside ExpoWidgets so its internal ActivityAttributes and storage types
// stay in their original module. Business logic belongs to ZoridActions instead.
actor ZoridActionSurfaces {
  static let shared = ZoridActionSurfaces()
  private let prefixes = ["zorid-action:", "zorid-activity-action:"]

  func perform(target: String?) async throws -> Bool {
    guard let target, let prefix = prefixes.first(where: { target.hasPrefix($0) }) else { return false }
    let encoded = String(target.dropFirst(prefix.count))
    guard !encoded.isEmpty, encoded.utf8.count <= 32_768,
          encoded.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
      throw ZoridSurfaceError.invalidTarget
    }
    let base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padded = base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4)
    guard let data = Data(base64Encoded: padded),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let appId = request["appId"] as? String,
          let requestJSON = String(data: data, encoding: .utf8) else {
      throw ZoridSurfaceError.invalidTarget
    }
    let lock = try acquireLock()
    defer { releaseLock(lock.descriptor) }
    _ = try ZoridActionRuntime.shared.dispatch(requestJSON)
    // A running app observes this; a cold app reloads shared records on activation.
    WidgetsEvents.shared.sendNotification(type: .userEvent, data: [
      "source": "ZoridActions", "target": appId,
      "timestamp": Int(Date().timeIntervalSince1970 * 1000)
    ])
    _ = try await flushPending(appId: appId, directory: lock.directory)
    return true
  }

  func flush(appId: String) async throws -> Int {
    let lock = try acquireLock()
    defer { releaseLock(lock.descriptor) }
    return try await flushPending(appId: appId, directory: lock.directory)
  }

  private func flushPending(appId: String, directory: URL) async throws -> Int {
    // Re-read only after obtaining the cross-process lock. An old pending activity
    // effect must not overwrite a newer widget-only update that was already applied.
    let checkpointURL = directory.appendingPathComponent("zorid-surface-checkpoints.json")
    var checkpoints: [String: Int64] = [:]
    if FileManager.default.fileExists(atPath: checkpointURL.path) {
      checkpoints = try JSONDecoder().decode([String: Int64].self, from: Data(contentsOf: checkpointURL))
    }
    var count = 0
    for _ in 0..<4 {
      let encoded = try ZoridActionRuntime.shared.pendingEffects(appId: appId)
      guard let data = encoded.data(using: .utf8),
            let effects = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        throw ZoridSurfaceError.invalidEffect
      }
      if effects.isEmpty { return count }
      var deferredActivity = false
      for effect in effects {
        guard let id = effect["id"] as? String,
              effect["appId"] as? String == appId,
              let sequenceNumber = effect["sequence"] as? NSNumber else {
          throw ZoridSurfaceError.invalidEffect
        }
        let sequence = sequenceNumber.int64Value
        guard sequence > 0, let props = effect["props"] as? [String: Any] else {
          throw ZoridSurfaceError.invalidEffect
        }
        var complete = true
        if let widget = effect["widget"] as? String {
          let key = "widget:\(widget)"
          if sequence > (checkpoints[key] ?? 0) {
            try updateWidget(name: widget, props: props, timeline: effect["timeline"])
            checkpoints[key] = sequence
            try saveCheckpoints(checkpoints, to: checkpointURL)
          }
        }
        if let activity = effect["activity"] as? String {
          let key = "activity:\(activity)"
          if sequence > (checkpoints[key] ?? 0) {
            if Bundle.main.bundleURL.pathExtension == "appex" {
              // ActivityKit mutations execute from the containing app, including a
              // LiveActivityIntent. Preserve the effect until that context is available.
              complete = false
              deferredActivity = true
            } else {
              try await updateActivity(name: activity, props: props, end: effect["endActivity"] as? Bool ?? false,
                                       staleAt: (effect["staleAt"] as? NSNumber)?.doubleValue,
                                       start: effect["startActivity"] as? Bool ?? false, url: effect["url"] as? String)
              checkpoints[key] = sequence
              try saveCheckpoints(checkpoints, to: checkpointURL)
            }
          }
        }
        if complete {
          try ZoridActionRuntime.shared.acknowledgeEffects(ids: [id])
          count += 1
        }
      }
      if deferredActivity { throw ZoridSurfaceError.activityRequiresApp }
    }
    let remaining = try ZoridActionRuntime.shared.pendingEffects(appId: appId)
    guard let remainingData = remaining.data(using: .utf8),
          let remainingEffects = try JSONSerialization.jsonObject(with: remainingData) as? [[String: Any]] else {
      throw ZoridSurfaceError.invalidEffect
    }
    if !remainingEffects.isEmpty { throw ZoridSurfaceError.morePending }
    return count
  }

  private func updateWidget(name: String, props: [String: Any], timeline value: Any?) throws {
    guard let defaults = WidgetsStorage.defaults,
          WidgetsLayoutRegistry.layout(for: name) != nil else { throw ZoridSurfaceError.unavailableStorage }
    let entries: [[String: Any]]
    if let timeline = value as? [[String: Any]], !timeline.isEmpty {
      entries = try timeline.map { item in
        guard let timestamp = item["date"] as? NSNumber,
              timestamp.doubleValue.isFinite,
              let props = item["props"] as? [String: Any] else { throw ZoridSurfaceError.invalidEffect }
        return ["timestamp": timestamp.int64Value, "props": props]
      }
    } else {
      entries = [["timestamp": Int64(Date().timeIntervalSince1970 * 1000), "props": props]]
    }
    // UserDefaults cannot store JSON null. Check before calling Foundation, which
    // otherwise raises an Objective-C exception rather than a catchable Swift error.
    guard PropertyListSerialization.propertyList(entries, isValidFor: .binary) else {
      throw ZoridSurfaceError.invalidEffect
    }
    WidgetsStorage.set(entries, forKey: "__expo_widgets_\(name)_timeline")
    guard defaults.synchronize() else { throw ZoridSurfaceError.unavailableStorage }
    WidgetCenter.shared.reloadTimelines(ofKind: name)
  }

  private func updateActivity(name: String, props: [String: Any], end: Bool, staleAt: Double?,
                              start: Bool, url: String?) async throws {
    let propsData = try JSONSerialization.data(withJSONObject: props, options: [.sortedKeys])
    guard let propsJSON = String(data: propsData, encoding: .utf8) else { throw ZoridSurfaceError.invalidEffect }
    if let url {
      guard url.utf8.count <= 2048, url.hasPrefix("zorid://"),
            let components = URLComponents(string: url), components.scheme == "zorid",
            components.host?.isEmpty == false, components.user == nil, components.password == nil else {
        throw ZoridSurfaceError.invalidEffect
      }
    }
    let state = LiveActivityAttributes.ContentState(name: name, props: propsJSON)
    let encodedState = try JSONEncoder().encode(state)
    let staleDate = staleAt.flatMap { $0.isFinite ? Date(timeIntervalSince1970: $0 / 1000) : nil }
    let content = ActivityContent(state: state, staleDate: staleDate)
    let instances = Activity<LiveActivityAttributes>.activities.filter {
      $0.content.state.name == name && ($0.activityState == .active || $0.activityState == .stale)
    }
    for activity in instances {
      guard encodedState.count + (try JSONEncoder().encode(activity.attributes)).count <= 4096 else {
        throw ZoridSurfaceError.oversizedActivity
      }
      if end { await activity.end(content, dismissalPolicy: .immediate) }
      else { await activity.update(content) }
    }
    if instances.isEmpty && start && !end {
      // Only app-process flushes reach this method. ActivityKit may still reject a
      // background start; propagate that error and retain the effect for foreground.
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw ZoridSurfaceError.liveActivitiesUnavailable
      }
      let attributes = LiveActivityAttributes(url: url)
      guard encodedState.count + (try JSONEncoder().encode(attributes)).count <= 4096 else {
        throw ZoridSurfaceError.oversizedActivity
      }
      _ = try Activity.request(attributes: attributes, content: content, pushType: nil)
    }
  }

  private func acquireLock() throws -> (descriptor: Int32, directory: URL) {
    guard let identifier = WidgetsStorage.appGroupIdentifier,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) else {
      throw ZoridSurfaceError.unavailableStorage
    }
    let directory = container.appendingPathComponent("SQLite", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let descriptor = open(directory.appendingPathComponent("zorid-surface-effects.lock").path,
                          O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw ZoridSurfaceError.unavailableStorage }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      close(descriptor)
      throw ZoridSurfaceError.busy
    }
    return (descriptor, directory)
  }

  private func releaseLock(_ descriptor: Int32) {
    flock(descriptor, LOCK_UN)
    close(descriptor)
  }

  private func saveCheckpoints(_ checkpoints: [String: Int64], to destination: URL) throws {
    try JSONEncoder().encode(checkpoints).write(to: destination, options: .atomic)
  }
}
