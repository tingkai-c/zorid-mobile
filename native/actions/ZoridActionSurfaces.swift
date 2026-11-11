import Foundation
import Darwin
import WidgetKit
import ActivityKit
import ZoridActions

private enum ZoridSurfaceError: LocalizedError {
  case invalidTarget, invalidEffect, unavailableStorage, widgetLayoutUnavailable, busy, activityRequiresApp, oversizedActivity, liveActivitiesUnavailable

  var errorDescription: String? {
    switch self {
    case .invalidTarget: return "The widget action is invalid."
    case .invalidEffect: return "The saved surface update is invalid."
    case .unavailableStorage: return "Shared widget storage is unavailable."
    case .widgetLayoutUnavailable: return "The widget layout is not ready. Open Zorid and try again."
    case .busy: return "Another surface update is in progress. Please try again."
    case .activityRequiresApp: return "Your change is saved. Open Zorid to refresh the Live Activity."
    case .oversizedActivity: return "The Live Activity update exceeds its data limit."
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
    let checkpointURL = directory.appendingPathComponent("zorid-surface-checkpoints.json")
    let checkpoints: [String: Int64]
    if FileManager.default.fileExists(atPath: checkpointURL.path) {
      checkpoints = try JSONDecoder().decode([String: Int64].self, from: Data(contentsOf: checkpointURL))
    } else { checkpoints = [:] }
    return try await ZoridSurfaceEffectQueue.flush(
      appId: appId, initialCheckpoints: checkpoints,
      fetch: { cursor in
        let encoded = try ZoridActionRuntime.shared.pendingEffects(appId: appId, afterSequence: cursor)
        guard let data = encoded.data(using: .utf8),
              let effects = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
          throw ZoridSurfaceError.invalidEffect
        }
        return effects
      },
      applyWidget: { effect in
        guard let widget = effect.widget,
              let props = effect.payload["props"] as? [String: Any] else { throw ZoridSurfaceError.invalidEffect }
        try self.updateWidget(name: widget, props: props, timeline: effect.payload["timeline"])
      },
      applyActivity: { effect in
        guard Bundle.main.bundleURL.pathExtension != "appex" else {
          throw ZoridSurfaceError.activityRequiresApp
        }
        guard let activity = effect.activity,
              let props = effect.payload["props"] as? [String: Any] else { throw ZoridSurfaceError.invalidEffect }
        try await self.updateActivity(name: activity, props: props,
          end: effect.payload["endActivity"] as? Bool ?? false,
          staleAt: (effect.payload["staleAt"] as? NSNumber)?.doubleValue,
          start: effect.payload["startActivity"] as? Bool ?? false, url: effect.payload["url"] as? String)
      },
      saveCheckpoints: { try self.saveCheckpoints($0, to: checkpointURL) },
      acknowledge: { try ZoridActionRuntime.shared.acknowledgeEffects(ids: $0) }
    )
  }

  private func updateWidget(name: String, props: [String: Any], timeline value: Any?) throws {
    guard WidgetsStorage.defaults != nil else { throw ZoridSurfaceError.unavailableStorage }
    guard WidgetsLayoutRegistry.layout(for: name) != nil else { throw ZoridSurfaceError.widgetLayoutUnavailable }
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
    // UserDefaults propagates writes automatically. A legacy synchronize() return
    // value is not a prerequisite to reload; Expo uses the same set/reload order.
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
      // Ending stops the activity while allowing its final content to remain
      // visible on the Lock Screen until the person or iOS dismisses it.
      if end { await activity.end(content, dismissalPolicy: .default) }
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
