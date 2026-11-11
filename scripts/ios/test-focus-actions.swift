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
    try runtime.installBundle(actionJSON(["appId":"productivity", "version":"focus-actions-1", "runtimeVersion":1,
      "capabilities":["records","surfaces"], "handlers":["focus.control":source,"focus.publish":source]]))
    let db = try ZoridActionConnection(url: directory.appendingPathComponent("zorid.db"))
    let now = floor(Date().timeIntervalSince1970 * 1000)
    let session: [String: Any] = ["id":"focus-check", "taskId":NSNull(), "taskTitle":"Write 🦦", "startedAt":now-5000,
      "targetMs":60000,"intervals":[],"runningSince":now-5000,"status":"running","endedAt":NSNull()]
    try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","sessions","focus-check",1,now,try actionJSON(session)])
    try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","state","focus-current",1,now,"{\"sessionId\":\"focus-check\"}"])

    func publish(_ id: String) throws -> [String: Any] {
      try object(runtime.dispatch(actionJSON(["appId":"productivity","actionId":"focus.publish","invocationId":id,
        "bundleVersion":"focus-actions-1","args":["action":"publish"]])))
    }
    let running = try publish("publish-running")
    let initialEffect = (running["effects"] as! [[String: Any]])[0]
    try expect(initialEffect["startActivity"] as? Bool == true, "Foreground publication must be able to start its activity")
    let initialProps = initialEffect["props"] as! [String: Any]
    let pause = try request(initialProps["pauseTarget"] as! String)
    let paused = try object(runtime.dispatch(pause))
    try expect((paused["result"] as! [String: Any])["status"] as? String == "paused", "Bare JavaScriptCore must persist pause")
    try expect((try object(runtime.dispatch(pause)))["duplicate"] as? Bool == true, "Native focus retry must deduplicate")
    let pausedProps = ((paused["effects"] as! [[String: Any]])[0]["props"] as! [String: Any])
    let resumed = try object(runtime.dispatch(request(pausedProps["resumeTarget"] as! String)))
    try expect((resumed["result"] as! [String: Any])["status"] as? String == "running", "Bare JavaScriptCore must resume")
    let resumedProps = ((resumed["effects"] as! [[String: Any]])[0]["props"] as! [String: Any])
    let finished = try object(runtime.dispatch(request(resumedProps["finishTarget"] as! String)))
    try expect((finished["result"] as! [String: Any])["status"] as? String == "completed", "Bare JavaScriptCore must finish")
    let saved = try db.rows("SELECT data FROM documents WHERE feature=? AND collection=? AND id=?", ["productivity","sessions","focus-check"])
    try expect((try object(saved[0]["data"] as! String))["status"] as? String == "completed", "Finished session must be durable")
    let finalEffect = (try publish("publish-finished"))["effects"] as! [[String: Any]]
    try expect(finalEffect[0]["endActivity"] as? Bool == true, "Completion must end existing activity")
    let finalProps = finalEffect[0]["props"] as! [String: Any]
    try expect(finalProps["pauseTarget"] == nil && finalProps["resumeTarget"] == nil && finalProps["finishTarget"] == nil, "Completed widget must have no controls")

    // Match an app reading raw SQLite JSON with JSON.parse, rather than creating
    // the revision through the native bridge under test. Foundation previously
    // rounded this decimal differently, so the real handler rejected a fresh Pause.
    let fractional = #"{"id":"focus-fractional","taskId":null,"taskTitle":"Synthetic fractional focus","startedAt":1794400000000.000244140625,"targetMs":315360000000,"intervals":[],"runningSince":1794400000000.000244140625,"status":"running","endedAt":null}"#
    try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity","sessions","focus-fractional",1,now,fractional])
    let fractionalPause = try object(runtime.dispatch(actionJSON([
      "appId":"productivity","actionId":"focus.control","invocationId":"pause-fractional-seam",
      "bundleVersion":"focus-actions-1","args":["sessionId":"focus-fractional",
        "revision":"running:1794400000000.0002:0:0:0","action":"pause"],
    ])))
    try expect((fractionalPause["result"] as! [String: Any])["status"] as? String == "paused", "A fresh app-side revision must pause the same fractional record in native actions")
    print("Native compiled focus action lifecycle passed")
  }
}
