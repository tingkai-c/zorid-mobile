import Foundation
import UIKit
import CoreHaptics
import CoreFoundation

enum ZoridCoreHapticsError: LocalizedError {
  case unsupported, foregroundRequired, invalidPattern, audioUnsupported, limit, missingPlayer, invalidCommand
  var errorDescription: String? {
    switch self {
    case .unsupported: return "This device does not support Core Haptics playback."
    case .foregroundRequired: return "Core Haptics playback requires the app to be in the foreground."
    case .invalidPattern: return "Use valid haptic-only AHAP data with a finite timeline of at most 120 seconds."
    case .audioUnsupported: return "This bridge supports haptic events only; audio events and waveform files are not supported."
    case .limit: return "Core Haptics supports at most 16 loaded players, 256 KiB per pattern and 1024 pattern entries/control points."
    case .missingPlayer: return "The haptic player is unavailable. Create a new player after engine stops or resets."
    case .invalidCommand: return "Invalid Core Haptics playback command or parameter value."
    }
  }
}

// App-only, main-queue service. Core Haptics owns synthesis and timing: pattern
// envelopes do not represent raw actuator PCM. Audio paths are never loaded.
final class ZoridCoreHaptics {
  static let shared = ZoridCoreHaptics()
  private final class Entry {
    let player: CHHapticAdvancedPatternPlayer
    let duration: Double
    let engineTicket: UInt64
    var playback = ZoridHapticPlayback()
    init(player: CHHapticAdvancedPatternPlayer, duration: Double, engineTicket: UInt64) {
      self.player = player; self.duration = duration; self.engineTicket = engineTicket
    }
  }
  private var engine: CHHapticEngine?
  private var engineID = UUID()
  private var engineCallbacks = ZoridHapticEpoch()
  private var players: [String: Entry] = [:]
  private var engineState = "idle"
  private var generation = 0
  private var stoppedReason: String?
  private var lastError: String?
  private var backgroundObserver: NSObjectProtocol?
  private init() {
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
      object: nil, queue: .main) { [weak self] _ in self?.shutdown(reason: "applicationBackgrounded", reset: false) }
  }

  func status() throws -> String {
    let capabilities = CHHapticEngine.capabilitiesForHardware()
    let now = engine?.currentTime ?? 0
    let snapshots: [[String: Any]] = players.keys.sorted().compactMap { id in
      guard let entry = players[id] else { return nil }
      entry.playback.project(at: now)
      return ["id": id, "duration": entry.duration, "state": entry.playback.state,
        "lastCommand": entry.playback.lastCommand as Any? ?? NSNull(), "stateSource": entry.playback.stateSource,
        "loopEnabled": entry.player.loopEnabled, "loopEnd": entry.player.loopEnd,
        "playbackRate": entry.player.playbackRate, "isMuted": entry.player.isMuted]
    }
    return try json(["available": true, "supportsHaptics": capabilities.supportsHaptics,
      "supportsAudio": capabilities.supportsAudio, "audioResources": false, "engine": engineState,
      "stateBasis": "commandsAndCallbacks",
      "generation": generation, "stoppedReason": stoppedReason as Any? ?? NSNull(),
      "lastError": lastError as Any? ?? NSNull(), "players": snapshots])
  }

  func start() throws {
    try requireForeground()
    do {
      let target = try ensureEngine()
      bindEngineCallbacks(target)
      try target.start()
      engineState = "running"; lastError = nil; stoppedReason = nil
    }
    catch { shutdown(reason: "startFailed", reset: false); record(error); throw error }
  }

  func stop() { shutdown(reason: "applicationRequested", reset: false) }
  func reset() { shutdown(reason: "applicationReset", reset: true) }

  func create(patternJSON: String) throws -> String {
    guard players.count < 16 else { throw ZoridCoreHapticsError.limit }
    let dictionary = try validatePattern(patternJSON)
    let ahap = Dictionary(uniqueKeysWithValues: dictionary.map { (CHHapticPattern.Key(rawValue: $0.key), $0.value) })
    do {
      let pattern = try CHHapticPattern(dictionary: ahap)
      guard pattern.duration.isFinite, pattern.duration >= 0, pattern.duration <= 120 else { throw ZoridCoreHapticsError.invalidPattern }
      try start()
      let target = try ensureEngine()
      let player = try target.makeAdvancedPlayer(with: pattern)
      let id = UUID().uuidString.lowercased()
      let entry = Entry(player: player, duration: pattern.duration, engineTicket: engineCallbacks.value)
      players[id] = entry
      bindCompletion(entry, id: id)
      return try json(["id": id, "duration": pattern.duration])
    } catch { lastError = error.localizedDescription; throw error }
  }

  func command(playerID: String, commandJSON: String) throws {
    guard UUID(uuidString: playerID) != nil, let entry = players[playerID] else { throw ZoridCoreHapticsError.missingPlayer }
    let command = try object(commandJSON, maximum: 262_144)
    guard let type = command["type"] as? String else { throw ZoridCoreHapticsError.invalidCommand }
    if type != "dispose" { try requireForeground() }
    do {
      switch type {
      case "start", "stop", "pause", "resume":
        try keys(command, ["type", "delay"])
        let delay = try optionalNumber(command["delay"], default: 0, range: 0...60)
        try requireForeground()
        if type == "start" || type == "resume" {
          try start()
          // A stopped/reset handler may have invalidated this handle.
          guard players[playerID] === entry else { throw ZoridCoreHapticsError.missingPlayer }
        }
        let now = engine?.currentTime ?? 0
        let time = delay == 0 ? CHHapticTimeImmediate : now + delay
        if type == "start" || type == "resume" { bindCompletion(entry, id: playerID) }
        switch type {
        case "start": try entry.player.start(atTime: time)
        case "stop": try entry.player.stop(atTime: time)
        case "pause": try entry.player.pause(atTime: time)
        default: try entry.player.resume(atTime: time)
        }
        entry.playback.accepted(type, at: now + delay, now: now)
      case "seek":
        try keys(command, ["type", "offset"])
        try entry.player.seek(toOffset: number(command["offset"], range: 0...entry.duration))
      case "configure":
        try configure(entry, command)
      case "parameters":
        try keys(command, ["type", "parameters", "delay"])
        guard let parameters = command["parameters"] as? [[String: Any]], !parameters.isEmpty, parameters.count <= 1024 else {
          throw ZoridCoreHapticsError.invalidCommand
        }
        let dynamic = try parameters.map { value -> CHHapticDynamicParameter in
          try keys(value, ["id", "value"])
          let (id, range) = try dynamicID(value["id"])
          return CHHapticDynamicParameter(parameterID: id, value: Float(try number(value["value"], range: range)), relativeTime: 0)
        }
        try entry.player.sendParameters(dynamic, atTime: scheduledTime(command["delay"]))
      case "curve":
        try keys(command, ["type", "id", "points", "delay"])
        let (id, range) = try dynamicID(command["id"])
        guard let points = command["points"] as? [[String: Any]], !points.isEmpty, points.count <= 1024 else {
          throw ZoridCoreHapticsError.invalidCommand
        }
        var previous: Double = -1
        let controlPoints = try points.map { point -> CHHapticParameterCurve.ControlPoint in
          try keys(point, ["time", "value"])
          let time = try number(point["time"], range: 0...120)
          guard time >= previous else { throw ZoridCoreHapticsError.invalidCommand }
          previous = time
          return CHHapticParameterCurve.ControlPoint(relativeTime: time, value: Float(try number(point["value"], range: range)))
        }
        let curve = CHHapticParameterCurve(parameterID: id, controlPoints: controlPoints, relativeTime: 0)
        try entry.player.scheduleParameterCurve(curve, atTime: scheduledTime(command["delay"]))
      case "dispose":
        try keys(command, ["type"])
        try entry.player.cancel()
        entry.player.completionHandler = nil
        players.removeValue(forKey: playerID)
      default: throw ZoridCoreHapticsError.invalidCommand
      }
    } catch { lastError = error.localizedDescription; throw error }
  }

  private func configure(_ entry: Entry, _ command: [String: Any]) throws {
    try keys(command, ["type", "loopEnabled", "loopEnd", "playbackRate", "isMuted"])
    let loop = try optionalBool(command["loopEnabled"])
    let muted = try optionalBool(command["isMuted"])
    let loopEnd = try command["loopEnd"].map { try number($0, range: 0...entry.duration) }
    let rate = try command["playbackRate"].map { value -> Float in
      let number = try number(value, range: Double.leastNonzeroMagnitude...Double.greatestFiniteMagnitude)
      let native = Float(number)
      guard native.isFinite, native > 0 else { throw ZoridCoreHapticsError.invalidCommand }
      return native
    }
    if let loop { entry.player.loopEnabled = loop }
    if let loopEnd { entry.player.loopEnd = loopEnd }
    if let rate { entry.player.playbackRate = rate }
    if let muted { entry.player.isMuted = muted }
  }

  private func ensureEngine() throws -> CHHapticEngine {
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { throw ZoridCoreHapticsError.unsupported }
    if let engine { return engine }
    let target = try CHHapticEngine()
    let identity = UUID()
    engineID = identity
    target.playsHapticsOnly = true
    target.isAutoShutdownEnabled = true
    engine = target
    return target
  }

  private func bindCompletion(_ entry: Entry, id: String) {
    let currentEngine = engineID
    let ticket = entry.playback.callbacks.advance()
    entry.player.completionHandler = { [weak self, weak entry] error in
      DispatchQueue.main.async {
        guard let self, self.engineID == currentEngine, let entry, self.players[id] === entry else { return }
        guard entry.playback.completed(ticket: ticket, failed: error != nil, now: self.engine?.currentTime ?? 0) else { return }
        if let error { self.lastError = error.localizedDescription }
      }
    }
  }

  private func bindEngineCallbacks(_ target: CHHapticEngine) {
    let identity = engineID
    let ticket = engineCallbacks.advance()
    target.stoppedHandler = { [weak self] reason in
      DispatchQueue.main.async {
        guard let self, self.engineID == identity else { return }
        guard self.engineCallbacks.accepts(ticket) else {
          self.retireOlderPlayers(through: ticket)
          return
        }
        self.retireEngine()
        self.engineState = "stopped"
        self.stoppedReason = "\(reason.rawValue)"
      }
    }
    target.resetHandler = { [weak self] in
      DispatchQueue.main.async {
        guard let self, self.engineID == identity else { return }
        guard self.engineCallbacks.accepts(ticket) else {
          self.retireOlderPlayers(through: ticket)
          return
        }
        self.retireEngine()
        self.engineState = "reset"
        self.stoppedReason = "engineReset"
      }
    }
  }

  private func retireEngine() {
    engine?.stoppedHandler = nil
    engine?.resetHandler = nil
    engine = nil
    engineID = UUID()
    engineCallbacks.advance()
    invalidatePlayers()
  }

  private func retireOlderPlayers(through ticket: UInt64) {
    // A reset/stopped callback queued before restart still invalidates handles
    // from its old generation, but cannot remove players created after restart.
    let retired = ZoridHapticEpoch.retiredHandles(createdAt: players.mapValues { $0.engineTicket }, through: ticket)
    guard !retired.isEmpty else { return }
    for id in retired {
      guard let entry = players.removeValue(forKey: id) else { continue }
      entry.player.completionHandler = nil
      try? entry.player.cancel()
    }
    generation += 1
  }

  private func shutdown(reason: String, reset: Bool) {
    let previous = engine
    retireEngine()
    engineState = reset ? "idle" : "stopped"
    stoppedReason = reason
    if reset { lastError = nil }
    previous?.stoppedHandler = nil
    previous?.resetHandler = nil
    let stoppedIdentity = engineID
    previous?.stop(completionHandler: { [weak self] error in
      if let error {
        DispatchQueue.main.async {
          guard let self, self.engineID == stoppedIdentity else { return }
          self.lastError = error.localizedDescription
        }
      }
    })
  }

  private func invalidatePlayers() {
    for entry in players.values { entry.player.completionHandler = nil }
    players.removeAll()
    generation += 1
  }

  private func requireForeground() throws {
    guard UIApplication.shared.applicationState == .active else { throw ZoridCoreHapticsError.foregroundRequired }
  }

  private func scheduledTime(_ value: Any?) throws -> Double {
    let delay = try optionalNumber(value, default: 0, range: 0...60)
    return delay == 0 ? CHHapticTimeImmediate : (engine?.currentTime ?? 0) + delay
  }

  private func record(_ error: Error) { lastError = error.localizedDescription; engineState = "failed" }
  private func json(_ value: [String: Any]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
  }
  private func object(_ value: String, maximum: Int) throws -> [String: Any] {
    guard value.utf8.count <= maximum, let result = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else {
      throw ZoridCoreHapticsError.invalidCommand
    }
    return result
  }
  private func keys(_ object: [String: Any], _ allowed: Set<String>) throws {
    guard Set(object.keys).isSubset(of: allowed) else { throw ZoridCoreHapticsError.invalidCommand }
  }
  private func number(_ value: Any?, range: ClosedRange<Double>) throws -> Double {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
          range.contains(value.doubleValue) else { throw ZoridCoreHapticsError.invalidCommand }
    return value.doubleValue
  }
  private func optionalNumber(_ value: Any?, default fallback: Double, range: ClosedRange<Double>) throws -> Double {
    try value.map { try number($0, range: range) } ?? fallback
  }
  private func optionalBool(_ value: Any?) throws -> Bool? {
    guard let value else { return nil }
    guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw ZoridCoreHapticsError.invalidCommand }
    return value.boolValue
  }
  private func dynamicID(_ value: Any?) throws -> (CHHapticDynamicParameter.ID, ClosedRange<Double>) {
    guard let id = value as? String else { throw ZoridCoreHapticsError.invalidCommand }
    let range: ClosedRange<Double>
    switch id {
    case "HapticIntensityControl": range = 0...1
    case "HapticSharpnessControl", "HapticAttackTimeControl", "HapticDecayTimeControl", "HapticReleaseTimeControl": range = -1...1
    default: throw ZoridCoreHapticsError.invalidCommand
    }
    return (CHHapticDynamicParameter.ID(rawValue: id), range)
  }

  private func validatePattern(_ value: String) throws -> [String: Any] {
    let pattern = try object(value, maximum: 262_144)
    guard let items = pattern["Pattern"] as? [[String: Any]], !items.isEmpty, items.count <= 1024 else {
      throw ZoridCoreHapticsError.invalidPattern
    }
    var pointsCount = 0
    var hasEvent = false
    for item in items {
      guard item.count == 1 else { throw ZoridCoreHapticsError.invalidPattern }
      if let event = item["Event"] as? [String: Any] {
        hasEvent = true
        guard let type = event["EventType"] as? String,
              type == "HapticTransient" || type == "HapticContinuous", event["EventWaveformPath"] == nil else {
          throw ZoridCoreHapticsError.audioUnsupported
        }
        let time = try optionalNumber(event["Time"], default: 0, range: 0...120)
        let duration = try optionalNumber(event["EventDuration"], default: 0, range: 0...30)
        guard time + duration <= 120 else { throw ZoridCoreHapticsError.invalidPattern }
        if let parameters = event["EventParameters"] {
          guard let parameters = parameters as? [[String: Any]], parameters.count <= 1024 else { throw ZoridCoreHapticsError.invalidPattern }
          pointsCount += parameters.count
          for parameter in parameters {
            guard let id = parameter["ParameterID"] as? String,
                  ["HapticIntensity", "HapticSharpness", "AttackTime", "DecayTime", "ReleaseTime", "Sustained"].contains(id) else {
              throw ZoridCoreHapticsError.invalidPattern
            }
            _ = try number(parameter["ParameterValue"], range: 0...1)
          }
        }
      } else if let parameter = item["Parameter"] as? [String: Any] {
        let (_, range) = try dynamicID(parameter["ParameterID"])
        _ = try number(parameter["ParameterValue"], range: range)
        _ = try optionalNumber(parameter["Time"], default: 0, range: 0...120)
      } else if let curve = item["ParameterCurve"] as? [String: Any] {
        let (_, range) = try dynamicID(curve["ParameterID"])
        let start = try optionalNumber(curve["Time"], default: 0, range: 0...120)
        guard let points = curve["ParameterCurveControlPoints"] as? [[String: Any]], !points.isEmpty else {
          throw ZoridCoreHapticsError.invalidPattern
        }
        pointsCount += points.count
        var previous: Double = -1
        for point in points {
          let time = try number(point["Time"], range: 0...(120 - start))
          guard time >= previous else { throw ZoridCoreHapticsError.invalidPattern }
          previous = time
          _ = try number(point["ParameterValue"], range: range)
        }
      } else { throw ZoridCoreHapticsError.invalidPattern }
      guard pointsCount <= 1024 else { throw ZoridCoreHapticsError.limit }
    }
    guard hasEvent else { throw ZoridCoreHapticsError.invalidPattern }
    return pattern
  }
}
