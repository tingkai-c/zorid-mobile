import Foundation

// Callback closures capture a ticket before native work begins. A later start
// retires callbacks already waiting on the main queue, even for the same object.
struct ZoridHapticEpoch {
  private(set) var value: UInt64 = 0
  @discardableResult mutating func advance() -> UInt64 { value &+= 1; return value }
  func accepts(_ ticket: UInt64) -> Bool { value == ticket }
  static func retiredHandles(createdAt: [String: UInt64], through ticket: UInt64) -> Set<String> {
    Set(createdAt.compactMap { $0.value <= ticket ? $0.key : nil })
  }
}

// Core Haptics exposes no isPlaying property. This is a deterministic projection
// of accepted commands, engine clock and completion callbacks, not measurement.
struct ZoridHapticPlayback {
  private struct Transition {
    let time: Double
    let order: UInt64
    let command: String
  }
  var callbacks = ZoridHapticEpoch()
  private(set) var state = "ready"
  private(set) var lastCommand: String?
  private(set) var stateSource = "command"
  private var pending: [Transition] = []
  private var nextOrder: UInt64 = 0

  mutating func accepted(_ command: String, at time: Double, now: Double) {
    project(at: now)
    lastCommand = command
    nextOrder &+= 1
    pending.append(Transition(time: time, order: nextOrder, command: command))
    pending.sort { $0.time == $1.time ? $0.order < $1.order : $0.time < $1.time }
    project(at: now)
    if time > now, (command == "start" || command == "resume"), state != "playing" { state = "scheduled" }
  }

  mutating func project(at now: Double) {
    while let transition = pending.first, transition.time <= now {
      switch transition.command {
      case "start", "resume": state = "playing"
      case "pause": state = "paused"
      default: state = "stopped"
      }
      stateSource = "command"
      pending.removeFirst()
    }
  }

  @discardableResult mutating func completed(ticket: UInt64, failed: Bool, now: Double) -> Bool {
    guard callbacks.accepts(ticket) else { return false }
    project(at: now)
    // A stop completion is distinct from reaching the end naturally. Keep any
    // later accepted transitions; a callback cannot erase their schedule.
    if state != "stopped" { state = failed ? "stopped" : "finished" }
    stateSource = "completion"
    return true
  }
}
