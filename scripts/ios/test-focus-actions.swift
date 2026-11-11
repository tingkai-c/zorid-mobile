import Foundation

@main
struct FocusActionChecks {
  static func object(_ json: String) throws -> [String: Any] { try actionParse(json) as! [String: Any] }
  static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    guard try condition() else { throw ZoridActionError(message) }
  }
  static func request(_ target: String) throws -> String {
    let prefix = "zorid-activity-action:"
    try expect(target.hasPrefix(prefix), "Focus action must use the activity intent")
    let encoded = String(target.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padded = encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4)
    guard let data = Data(base64Encoded: padded), let json = String(data: data, encoding: .utf8) else {
      throw ZoridActionError("Invalid focus target")
    }
    return json
  }
  static func main() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zorid-focus-checks-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let runtime = ZoridActionRuntime(directoryURL: directory)
    _ = try runtime.prepareDatabase(legacyDirectory: nil)
    let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    try runtime.installBundle(actionJSON(["appId":"productivity", "version":"focus-actions-2", "runtimeVersion":1,
      "capabilities":["records","surfaces","screenTime"], "handlers":["focus.start":source,"focus.control":source,"focus.publish":source]]))
    let db = try ZoridActionConnection(url: directory.appendingPathComponent("zorid.db"))
    let now = floor(Date().timeIntervalSince1970 * 1000)
    let session: [String: Any] = ["id":"focus-check", "taskId":NSNull(), "taskTitle":"Write 🦦", "startedAt":now-5000,
      "targetMs":60000,"intervals":[],"runningSince":now-5000,"status":"running","endedAt":NSNull()]
    try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","sessions","focus-check",1,now,try actionJSON(session)])
    try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","state","focus-current",1,now,"{\"sessionId\":\"focus-check\"}"])
    try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","state","focus-screen-time",1,now,"{\"policyId\":\"focus\"}"])

    func publish(_ id: String) throws -> [String: Any] {
      try object(runtime.dispatch(actionJSON(["appId":"productivity","actionId":"focus.publish","invocationId":id,
        "bundleVersion":"focus-actions-2","args":["action":"publish"]])))
    }
    let running = try publish("publish-running")
    let initialEffect = (running["effects"] as! [[String: Any]])[0]
    try expect(initialEffect["startActivity"] as? Bool == true, "Foreground publication must be able to start its activity")
    let initialProps = initialEffect["props"] as! [String: Any]
    func restriction(_ response: [String: Any]) throws -> [String: Any] {
      guard let command = (response["effects"] as? [[String: Any]])?.compactMap({ $0["screenTime"] as? [String: Any] }).first else {
        throw ZoridActionError("Focus must queue its blocking change alongside native surfaces")
      }
      return command
    }
    try expect(try restriction(running)["policyId"] as? String == "focus", "Running focus must activate its device-local policy")
    let pause = try request(initialProps["pauseTarget"] as! String)
    let paused = try object(runtime.dispatch(pause))
    try expect((paused["result"] as! [String: Any])["status"] as? String == "paused", "Bare JavaScriptCore must persist pause")
    try expect(try restriction(paused)["clear"] as? Bool == true, "Pause must queue unblocking in the same durable action")
    try expect((try object(runtime.dispatch(pause)))["duplicate"] as? Bool == true, "Native focus retry must deduplicate")
    let pausedProps = ((paused["effects"] as! [[String: Any]])[0]["props"] as! [String: Any])
    let resumed = try object(runtime.dispatch(request(pausedProps["resumeTarget"] as! String)))
    try expect((resumed["result"] as! [String: Any])["status"] as? String == "running", "Bare JavaScriptCore must resume")
    try expect(try restriction(resumed)["sessionId"] as? String == "focus-check", "Resume must restore blocking for this session")
    let resumedProps = ((resumed["effects"] as! [[String: Any]])[0]["props"] as! [String: Any])
    let finished = try object(runtime.dispatch(request(resumedProps["finishTarget"] as! String)))
    try expect((finished["result"] as! [String: Any])["status"] as? String == "completed", "Bare JavaScriptCore must finish")
    try expect(try restriction(finished)["clear"] as? Bool == true, "Finish must queue unblocking independently of React")
    let saved = try db.rows("SELECT data FROM documents WHERE feature=? AND collection=? AND id=?", ["productivity","sessions","focus-check"])
    try expect((try object(saved[0]["data"] as! String))["status"] as? String == "completed", "Finished session must be durable")
    let finalEffect = (try publish("publish-finished"))["effects"] as! [[String: Any]]
    try expect(finalEffect[0]["endActivity"] as? Bool == true, "Completion must end existing activity")
    let finalProps = finalEffect[0]["props"] as! [String: Any]
    try expect(finalProps["pauseTarget"] == nil && finalProps["resumeTarget"] == nil && finalProps["finishTarget"] == nil, "Completed widget must have no controls")

    // Starting depends on the durable current pointer, not the bounded list SDK.
    // History must remain usable after the collection exceeds its 1,000-row limit.
    try db.transaction {
      for index in 0...1000 {
        var historical = session
        historical["id"] = "history-\(index)"
        historical["status"] = "completed"
        historical["runningSince"] = NSNull()
        historical["endedAt"] = now
        try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","sessions","history-\(index)",1,now,try actionJSON(historical)])
      }
    }
    let startRequest = try actionJSON(["appId":"productivity","actionId":"focus.start","invocationId":"start-native-session",
      "bundleVersion":"focus-actions-2","args":["action":"start","sessionId":"focus-native-start","taskId":NSNull()]])
    let started = try object(runtime.dispatch(startRequest))
    try expect((started["result"] as! [String: Any])["status"] as? String == "running", "Starting must persist the session without React")
    try expect(try restriction(started)["sessionId"] as? String == "focus-native-start", "Starting must atomically queue blocking without a React effect")
    let pointer = try db.rows("SELECT data FROM documents WHERE feature='productivity' AND collection='state' AND id='focus-current'")
    try expect((try object(pointer[0]["data"] as! String))["sessionId"] as? String == "focus-native-start", "Native start updates the shared current pointer")
    try expect((try object(runtime.dispatch(startRequest)))["duplicate"] as? Bool == true, "Starting retries reuse the same durable session")
    let startProps = (started["effects"] as! [[String: Any]]).first(where: { $0["widget"] != nil })!["props"] as! [String: Any]
    _ = try runtime.dispatch(request(startProps["finishTarget"] as! String))

    // Match an app reading raw SQLite JSON with JSON.parse, rather than creating
    // the revision through the native bridge under test. Foundation previously
    // rounded this decimal differently, so the real handler rejected a fresh Pause.
    let fractional = #"{"id":"focus-fractional","taskId":null,"taskTitle":"Synthetic fractional focus","startedAt":1794400000000.000244140625,"targetMs":315360000000,"intervals":[],"runningSince":1794400000000.000244140625,"status":"running","endedAt":null}"#
    try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","sessions","focus-fractional",1,now,fractional])
    let fractionalPause = try object(runtime.dispatch(actionJSON([
      "appId":"productivity","actionId":"focus.control","invocationId":"pause-fractional-seam",
      "bundleVersion":"focus-actions-2","args":["sessionId":"focus-fractional",
        "revision":"running:1794400000000.0002:0:0:0","action":"pause"],
    ])))
    try expect((fractionalPause["result"] as! [String: Any])["status"] as? String == "paused", "A fresh app-side revision must pause the same fractional record in native actions")
    print("Native compiled focus action lifecycle passed")
  }
}
