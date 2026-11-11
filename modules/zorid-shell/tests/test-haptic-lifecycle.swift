import Foundation

@main struct HapticLifecycleTests {
  static func main() {
    var checks = 0
    func check(_ value: Bool) { precondition(value); checks += 1 }

    for restartedCommand in ["start", "resume"] {
      var player = ZoridHapticPlayback()
      let oldCompletion = player.callbacks.advance()
      player.accepted("start", at: 0, now: 0)
      // The old native completion is queued before a new start/resume is
      // accepted. Deliver it only after the new handler ticket is installed.
      let currentCompletion = player.callbacks.advance()
      player.accepted(restartedCommand, at: 5, now: 1)
      check(!player.completed(ticket: oldCompletion, failed: false, now: 2))
      check(player.lastCommand == restartedCommand)
      player.project(at: 6)
      check(player.state == "playing")
      check(player.completed(ticket: currentCompletion, failed: false, now: 7))
      check(player.state == "finished" && player.stateSource == "completion")
    }

    var engine = ZoridHapticEpoch()
    let queuedStopped = engine.advance()
    let queuedReset = engine.value
    let restarted = engine.advance()
    var handles = ["created-before-reset": queuedReset, "created-after-restart": restarted]
    for oldCallback in [queuedStopped, queuedReset] {
      for id in ZoridHapticEpoch.retiredHandles(createdAt: handles, through: oldCallback) { handles.removeValue(forKey: id) }
      check(handles.count == 1)
      check(handles["created-before-reset"] == nil && handles["created-after-restart"] != nil)
    }
    check(engine.accepts(restarted))
    // A current callback retires its entire generation. Later callbacks for
    // the old engine cannot invalidate a replacement engine's handles.
    engine.advance()
    check(!engine.accepts(restarted))

    var scheduled = ZoridHapticPlayback()
    let completion = scheduled.callbacks.advance()
    scheduled.accepted("start", at: 1, now: 0)
    scheduled.accepted("stop", at: 10, now: 0)
    check(scheduled.state == "scheduled")
    scheduled.project(at: 2)
    check(scheduled.state == "playing")
    scheduled.project(at: 10)
    check(scheduled.state == "stopped")
    check(scheduled.completed(ticket: completion, failed: false, now: 10))
    check(scheduled.state == "stopped")

    var futureResume = ZoridHapticPlayback()
    let finishing = futureResume.callbacks.advance()
    futureResume.accepted("start", at: 0, now: 0)
    futureResume.accepted("resume", at: 10, now: 0)
    check(futureResume.completed(ticket: finishing, failed: false, now: 2))
    check(futureResume.state == "finished")
    futureResume.project(at: 11)
    check(futureResume.state == "playing")

    var sameTime = ZoridHapticPlayback()
    sameTime.accepted("start", at: 5, now: 0)
    sameTime.accepted("pause", at: 5, now: 0)
    sameTime.accepted("resume", at: 8, now: 0)
    sameTime.project(at: 6)
    check(sameTime.state == "paused")
    sameTime.project(at: 9)
    check(sameTime.state == "playing")
    print("Haptic lifecycle checks passed: \(checks)")
  }
}
