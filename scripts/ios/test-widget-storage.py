"""Run the actual widget-write method against real Foundation on a macOS runner.

The app/extension frameworks are stubbed, but the method under test is extracted
verbatim from the tracked adapter. A UserDefaults subclass reproduces an accepted
write whose legacy synchronize() call returns false. No Apple account is needed.
"""
import argparse
from pathlib import Path
import subprocess
import tempfile


def declaration(source: str, marker: str) -> str:
    start = source.index(marker)
    opening = source.index("{", start)
    depth = 1
    position = opening + 1
    while depth:
        depth += (source[position] == "{") - (source[position] == "}")
        position += 1
    return source[start:position]


PRELUDE = r'''
import Foundation

final class AcceptedDefaults: UserDefaults {
  var synchronizationCalls = 0
  override func synchronize() -> Bool {
    synchronizationCalls += 1
    return false
  }
}
enum WidgetsStorage {
  static var defaults: UserDefaults?
  static func set(_ value: [[String: Any]], forKey key: String) {
    defaults?.set(value, forKey: key)
  }
}
enum WidgetsLayoutRegistry {
  static var registered = true
  static func layout(for name: String) -> String? { registered ? "function(){}" : nil }
}
final class WidgetCenter {
  static let shared = WidgetCenter()
  var reloads: [String] = []
  func reloadTimelines(ofKind name: String) { reloads.append(name) }
}
final class Adapter {
  func apply() throws {
    try updateWidget(name: "ZoridFocus", props: ["status": "paused"], timeline: nil)
  }
'''

CHECKS = r'''
}

@main struct WidgetStorageChecks {
  static func main() throws {
    let suite = "zorid-widget-storage-regression-\(UUID().uuidString)"
    guard let defaults = AcceptedDefaults(suiteName: suite) else { fatalError("Unable to create test defaults") }
    defer { defaults.removePersistentDomain(forName: suite) }
    WidgetsStorage.defaults = defaults
    var failure: String?
    do { try Adapter().apply() } catch { failure = error.localizedDescription }
    let entries = defaults.array(forKey: "__expo_widgets_ZoridFocus_timeline") as? [[String: Any]]
    let props = entries?.first?["props"] as? [String: Any]
    guard props?["status"] as? String == "paused" else {
      fatalError("Regression fixture did not reach the real UserDefaults write")
    }
    guard failure == nil else {
      fputs("FAIL: accepted widget timeline write incorrectly reported: \(failure!)\n", stderr)
      fputs("Timeline readback succeeded; synchronize calls: \(defaults.synchronizationCalls); reloads: \(WidgetCenter.shared.reloads.count)\n", stderr)
      exit(1)
    }
    guard WidgetCenter.shared.reloads == ["ZoridFocus"] else { fatalError("Accepted write must reload the widget") }
    WidgetsStorage.defaults = nil
    do {
      try Adapter().apply()
      fatalError("Missing shared defaults must remain a real error")
    } catch ZoridSurfaceError.unavailableStorage {
      print("Missing defaults correctly reports unavailable storage")
    } catch {
      fatalError("Missing defaults returned the wrong error: \(error.localizedDescription)")
    }
    guard WidgetCenter.shared.reloads == ["ZoridFocus"] else { fatalError("Missing defaults must not reload a widget") }

    WidgetsStorage.defaults = defaults
    WidgetsLayoutRegistry.registered = false
    defaults.removeObject(forKey: "__expo_widgets_ZoridFocus_timeline")
    do {
      try Adapter().apply()
      fatalError("A missing registered layout must remain a retryable error")
    } catch ZoridSurfaceError.widgetLayoutUnavailable {
      print("Missing layout correctly reports layout not ready rather than unavailable storage")
    } catch {
      fatalError("Missing layout returned the wrong error: \(error.localizedDescription)")
    }
    guard defaults.array(forKey: "__expo_widgets_ZoridFocus_timeline") == nil else {
      fatalError("Missing layout must fail before writing an incomplete timeline")
    }
    guard WidgetCenter.shared.reloads == ["ZoridFocus"] else { fatalError("Missing layout must not reload a widget") }
    print("Widget storage accepted-write, missing-defaults and missing-layout regressions passed")
  }
}
'''


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit", type=Path, help="Only emit Swift for inspection or a separate runner")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    adapter = (root / "native/actions/ZoridActionSurfaces.swift").read_text()
    method = declaration(adapter, "  private func updateWidget(")
    errors = declaration(adapter, "private enum ZoridSurfaceError:")
    swift = "import Foundation\n" + errors + "\n" + PRELUDE + method + CHECKS
    if args.emit:
        args.emit.write_text(swift)
    else:
        with tempfile.TemporaryDirectory(prefix="zorid-widget-storage-") as directory:
            source = Path(directory) / "WidgetStorageChecks.swift"
            executable = Path(directory) / "checks"
            source.write_text(swift)
            subprocess.run(["swiftc", "-parse-as-library", str(source), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)
