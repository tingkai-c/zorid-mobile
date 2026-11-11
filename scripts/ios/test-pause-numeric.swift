import Foundation

// Compile with the production Store + Runtime and JavaScriptCore on a macOS runner.
// Raw decimal JSON models Expo SQLite's persisted text. Each invocation compares
// JSON.parse(raw) with the same document returned by the native records.get bridge.
@main
struct PauseNumericChecks {
  static let source = #"""
    function(args, sdk) {
      function revision(session) {
        return [session.status, session.runningSince ?? 0, session.endedAt ?? 0,
          session.intervals.length, session.intervals.at(-1)?.endedAt ?? 0].join(':');
      }
      const mismatches = [];
      for (const raw of args.records) {
        const parsed = JSON.parse(raw);
        const bridged = sdk.records.get('sessions', parsed.id);
        const expected = revision(parsed);
        const actual = revision(bridged);
        if (expected !== actual || !Object.is(parsed.runningSince, bridged.runningSince)
          || !Object.is(parsed.intervals[0].endedAt, bridged.intervals[0].endedAt)) {
          mismatches.push({ id: parsed.id, raw, expected, actual,
            parsedNumber: parsed.runningSince.toPrecision(17),
            bridgedNumber: bridged.runningSince.toPrecision(17) });
        }
      }
      return mismatches;
    }
    """#

  static func main() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zorid-pause-numeric-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let runtime = ZoridActionRuntime(directoryURL: directory)
    _ = try runtime.prepareDatabase(legacyDirectory: nil)
    try runtime.installBundle(actionJSON([
      "appId": "productivity", "version": "pause-numeric-1", "runtimeVersion": 1,
      "capabilities": ["records"], "handlers": ["focus.numeric-probe": source],
    ]))
    let db = try ZoridActionConnection(url: directory.appendingPathComponent("zorid.db"))
    var tokens: [String] = []
    for epoch in ["1700000000000", "1767225600000", "1794400000000", "1794410000000"] {
      tokens.append(epoch)
      for fraction in 0..<1000 {
        tokens.append("\(epoch).\(String(format: "%03d", fraction))")
      }
      for fraction in ["0000001", "0001220703125", "000244140625", "0003662109375", "123456789", "999999999"] {
        tokens.append("\(epoch).\(fraction)")
      }
    }

    var mismatchCount = 0
    // Stay below the dispatch payload and capability-operation limits.
    for start in stride(from: 0, to: tokens.count, by: 96) {
      var records: [String] = []
      for index in start..<min(start + 96, tokens.count) {
        let id = "numeric-\(index)", token = tokens[index]
        let raw = """
          {"id":"\(id)","taskId":null,"taskTitle":"Synthetic numeric probe","startedAt":\(token),"targetMs":1500000,"intervals":[{"startedAt":\(token),"endedAt":\(token)}],"runningSince":\(token),"status":"running","endedAt":null}
          """
        try db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?)", ["productivity", "sessions", id, 1, 0, raw])
        records.append(raw)
      }
      let request = try actionJSON([
        "appId": "productivity", "actionId": "focus.numeric-probe", "invocationId": "numeric-batch-\(start)",
        "bundleVersion": "pause-numeric-1", "args": ["records": records],
      ])
      let response = try actionParse(runtime.dispatch(request)) as! [String: Any]
      let mismatches = response["result"] as! [[String: Any]]
      for mismatch in mismatches { print(try actionJSON(mismatch)) }
      mismatchCount += mismatches.count
    }
    guard mismatchCount == 0 else {
      throw ZoridActionError("Native numeric bridge disagreed with JSON.parse for \(mismatchCount) synthetic focus records.")
    }
    print("Native numeric bridge and JSON.parse agree for \(tokens.count) synthetic focus records")
  }
}
