import Foundation

struct ZoridSurfaceEffect {
  let id: String
  let sequence: Int64
  let widget: String?
  let activity: String?
  let hasScreenTime: Bool
  let payload: [String: Any]

  init(_ payload: [String: Any], appId: String) throws {
    guard let id = payload["id"] as? String, !id.isEmpty,
          payload["appId"] as? String == appId,
          let number = payload["sequence"] as? NSNumber,
          number.int64Value > 0, number.doubleValue == Double(number.int64Value) else { throw ZoridSurfaceQueueError.invalidEffect }
    self.id = id
    sequence = number.int64Value
    widget = payload["widget"] as? String
    activity = payload["activity"] as? String
    hasScreenTime = payload["screenTime"] is [String: Any]
    guard widget != nil || activity != nil || hasScreenTime,
          (widget == nil && activity == nil) || payload["props"] is [String: Any] else { throw ZoridSurfaceQueueError.invalidEffect }
    self.payload = payload
  }

  var keys: [String] {
    [widget.map { "widget:\($0)" }, activity.map { "activity:\($0)" },
     hasScreenTime ? "screenTime:\(payload["appId"] as! String)" : nil].compactMap { $0 }
  }
}

enum ZoridSurfaceQueueError: LocalizedError {
  case invalidEffect, morePending, screenTimeUnavailable

  var errorDescription: String? {
    switch self {
    case .invalidEffect: return "The saved surface update is invalid."
    case .morePending: return "Your changes are saved. More surface updates remain; refresh again."
    case .screenTimeUnavailable: return "Screen Time could not update. Install a Zorid binary with Screen Time support."
    }
  }
}

// Independent of WidgetKit, ActivityKit and SQLite so the ordering/failure rules
// can be exercised directly on the macOS runner with injected storage and effects.
enum ZoridSurfaceEffectQueue {
  static func flush(
    appId: String,
    initialCheckpoints: [String: Int64],
    fetch: (Int64) throws -> [[String: Any]],
    applyWidget: (ZoridSurfaceEffect) async throws -> Void,
    applyActivity: (ZoridSurfaceEffect) async throws -> Void,
    applyScreenTime: ((ZoridSurfaceEffect) async throws -> Void)? = nil,
    saveCheckpoints: ([String: Int64]) throws -> Void,
    acknowledge: ([String]) throws -> Void
  ) async throws -> Int {
    var checkpoints = initialCheckpoints
    let cursorKey = "cursor:\(appId)"
    var cursor = max(0, checkpoints[cursorKey] ?? 0)
    var mayWrap = cursor > 0
    var seen: [String: ZoridSurfaceEffect] = [:]
    var acknowledged = Set<String>()
    var errors: [(effect: ZoridSurfaceEffect, key: String?, error: Error)] = []

    func checkpoint(_ key: String, sequence: Int64) throws {
      var next = checkpoints
      next[key] = sequence
      try saveCheckpoints(next)
      checkpoints = next
    }
    func complete(_ effect: ZoridSurfaceEffect) -> Bool {
      effect.keys.allSatisfy { (checkpoints[$0] ?? 0) >= effect.sequence }
    }
    func acknowledgeIfComplete(_ effect: ZoridSurfaceEffect) {
      guard !acknowledged.contains(effect.id), complete(effect) else { return }
      do {
        try acknowledge([effect.id])
        acknowledged.insert(effect.id)
      } catch { errors.append((effect, nil, error)) }
    }

    // The native store pages eight effects. Four bounded pages per call keep an
    // unhealthy integration from monopolizing an intent. Persisted cursors ensure
    // even more than 32 failing effects cannot indefinitely starve newer widgets.
    for _ in 0..<4 {
      let batch = try fetch(cursor)
      if batch.isEmpty {
        if mayWrap {
          cursor = 0
          mayWrap = false
          continue
        }
        break
      }
      for payload in batch {
        let effect = try ZoridSurfaceEffect(payload, appId: appId)
        guard effect.sequence > cursor else { throw ZoridSurfaceQueueError.invalidEffect }
        cursor = effect.sequence
        if seen[effect.id] != nil { continue }
        seen[effect.id] = effect
        if effect.hasScreenTime {
          let key = "screenTime:\(appId)"
          if effect.sequence > (checkpoints[key] ?? 0) {
            do {
              guard let applyScreenTime else { throw ZoridSurfaceQueueError.screenTimeUnavailable }
              try await applyScreenTime(effect)
              try checkpoint(key, sequence: effect.sequence)
            } catch { errors.append((effect, key, error)) }
          }
        }
        if let widget = effect.widget {
          let key = "widget:\(widget)"
          if effect.sequence > (checkpoints[key] ?? 0) {
            do {
              try await applyWidget(effect)
              try checkpoint(key, sequence: effect.sequence)
            } catch { errors.append((effect, key, error)) }
          }
        }
        if let activity = effect.activity {
          let key = "activity:\(activity)"
          if effect.sequence > (checkpoints[key] ?? 0) {
            do {
              try await applyActivity(effect)
              try checkpoint(key, sequence: effect.sequence)
            } catch { errors.append((effect, key, error)) }
          }
        }
        // Neither a rejected activity nor a failed widget prevents the other
        // surface, or any later effect, from reaching its latest committed state.
        acknowledgeIfComplete(effect)
      }
    }

    // A newer successful update supersedes a previous failed update to the same
    // surface. Its old effect can now be acknowledged without retrying stale data.
    for effect in seen.values.sorted(by: { $0.sequence < $1.sequence }) {
      acknowledgeIfComplete(effect)
    }
    let tailRemains = !(try fetch(cursor)).isEmpty
    try checkpoint(cursorKey, sequence: tailRemains ? cursor : 0)
    let pending = try fetch(0)
    guard !pending.isEmpty else { return acknowledged.count }
    if let unresolved = errors.first(where: { failure in
      guard !acknowledged.contains(failure.effect.id) else { return false }
      return failure.key.map { (checkpoints[$0] ?? 0) < failure.effect.sequence } ?? true
    }) { throw unresolved.error }
    throw ZoridSurfaceQueueError.morePending
  }
}
