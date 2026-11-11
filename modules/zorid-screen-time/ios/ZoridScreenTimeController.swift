import Foundation
import CoreFoundation
import Darwin
import FamilyControls
import ManagedSettings
import DeviceActivity
import ImageIO

private struct ZoridScreenTimePolicy: Codable {
  let id: String
  let mode: String
  let selection: FamilyActivitySelection
  var shield: ZoridShieldDocument?
  private enum Keys: String, CodingKey { case id, mode, selection, shield }
  init(id: String, mode: String, selection: FamilyActivitySelection, shield: ZoridShieldDocument? = nil) {
    self.id = id; self.mode = mode; self.selection = selection; self.shield = shield
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: Keys.self)
    id = try values.decode(String.self, forKey: .id)
    mode = try values.decode(String.self, forKey: .mode)
    selection = try values.decode(FamilyActivitySelection.self, forKey: .selection)
    // Invalid optional presentation data falls back to the system-like shield;
    // it must never corrupt an otherwise valid blocking selection/session.
    shield = try? values.decode(ZoridShieldDocument.self, forKey: .shield)
  }
}
private struct ZoridScreenTimeActive: Codable {
  let policyId: String
  let sessionId: String
  let endsAt: Double
  let monitor: String
}
private struct ZoridScreenTimeState: Codable {
  var policies: [ZoridScreenTimePolicy] = []
  var active: ZoridScreenTimeActive?
}

// No React, UIApplication or timers. The same code is compiled into the monitor.
// App-group flock serializes intent/app/monitor changes across process boundaries.
public final class ZoridScreenTimeController {
  public static let shared = ZoridScreenTimeController()
  public static let group = "group.app.zorid.mobile"
  private let center = DeviceActivityCenter()
  private init() {}

  // Authorization revocation invalidates Apple tokens. Clear cached selections
  // before asking for fresh authorization, including policies in other tools.
  public func prepareAuthorization() throws {
    guard !authorized else { return }
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else {
      throw ZoridScreenTimeError.unavailableStorage
    }
    let directory = root.appendingPathComponent("ScreenTime", isDirectory: true)
    guard FileManager.default.fileExists(atPath: directory.path) else { return }
    for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      where file.pathExtension == "json" {
      let appId = file.deletingPathExtension().lastPathComponent
      guard (try? ZoridScreenTimePlan.identifier(appId)) != nil else { continue }
      try withState(appId) { state, destination in
        clearLocked(appId, state: &state)
        state.policies.removeAll()
        try save(state, to: destination)
      }
    }
  }

  public func status(appId: String) throws -> String {
    try withState(appId) { state, file in
      if !authorized || state.active.map({ $0.endsAt <= Date().timeIntervalSince1970 * 1000 }) == true {
        clearLocked(appId, state: &state)
        if !authorized { state.policies.removeAll() }
        try save(state, to: file)
      }
      let auth: String
      switch AuthorizationCenter.shared.authorizationStatus {
      case .approved: auth = "approved"
      case .denied: auth = "denied"
      default: auth = "notDetermined"
      }
      let policies: [[String: Any]] = state.policies.map {
        ["id": $0.id, "mode": $0.mode, "applicationCount": $0.selection.applicationTokens.count,
         "categoryCount": $0.selection.categoryTokens.count, "customShield": $0.shield != nil]
      }
      var result: [String: Any] = ["available": true, "authorization": auth, "policies": policies, "active": NSNull(),
        "shieldCapabilities": ["openApp": supportsOpenApp, "secondarySubmenu": supportsSecondarySubmenu]]
      if let active = state.active {
        result["active"] = ["policyId": active.policyId, "sessionId": active.sessionId, "endsAt": active.endsAt]
      }
      return String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self)
    }
  }

  public func selection(appId: String, policyId: String) throws -> FamilyActivitySelection {
    try ZoridScreenTimePlan.identifier(policyId)
    return try withState(appId) { state, _ in
      state.policies.first(where: { $0.id == policyId })?.selection ?? FamilyActivitySelection()
    }
  }

  public func savePolicy(appId: String, policyId: String, mode: String, selection: FamilyActivitySelection) throws {
    try ZoridScreenTimePlan.identifier(policyId)
    guard mode == "blocklist" || mode == "allowlist" else { throw ZoridScreenTimeError.invalidMode }
    guard authorized else { throw ZoridScreenTimeError.unavailableAuthorization }
    guard selection.applicationTokens.count <= 50,
          selection.webDomainTokens.isEmpty,
          mode != "blocklist" || !selection.applicationTokens.isEmpty || !selection.categoryTokens.isEmpty,
          mode != "allowlist" || selection.categoryTokens.isEmpty else { throw ZoridScreenTimeError.invalidSelection }
    try withState(appId) { state, file in
      guard state.active?.policyId != policyId else { throw ZoridScreenTimeError.policyActive }
      guard state.policies.count < 16 || state.policies.contains(where: { $0.id == policyId }) else {
        throw ZoridScreenTimeError.tooManyPolicies
      }
      let existingShield = state.policies.first(where: { $0.id == policyId })?.shield
      state.policies.removeAll { $0.id == policyId }
      state.policies.append(ZoridScreenTimePolicy(id: policyId, mode: mode, selection: selection, shield: existingShield))
      try save(state, to: file)
    }
  }

  public var supportsOpenApp: Bool {
    if #available(iOS 26.5, *) { return true }
    return false
  }

  public var supportsSecondarySubmenu: Bool {
    if #available(iOS 26.4, *) { return true }
    return false
  }

  // Inspect compressed PNG metadata before asking UIKit to allocate a bitmap.
  // The same guard runs on configuration and rendering of persisted documents.
  public static func validateShieldImage(_ style: ZoridShieldStyle) throws {
    guard case .png(let data)? = style.icon else { return }
    let options = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, options),
          CGImageSourceGetType(source) as String? == "public.png",
          CGImageSourceGetCount(source) == 1,
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
          width.intValue > 0, width.intValue <= 1024, height.intValue > 0, height.intValue <= 1024 else {
      throw ZoridShieldError.invalidImage
    }
  }

  public func configureShield(appId: String, policyId: String, configJSON: String?) throws {
    try ZoridScreenTimePlan.identifier(policyId)
    let config = try configJSON.map(ZoridShieldStyle.parse)
    if let config {
      if config.needsOpenApp, !supportsOpenApp { throw ZoridShieldError.unsupportedOpenApp }
      if config.secondaryButtonSubmenuItems != nil, !supportsSecondarySubmenu { throw ZoridShieldError.unsupportedSubmenu }
      try Self.validateShieldImage(config)
    }
    try withState(appId) { state, file in
      guard let index = state.policies.firstIndex(where: { $0.id == policyId }) else { throw ZoridScreenTimeError.policyMissing }
      state.policies[index].shield = config.map(ZoridShieldDocument.init)
      try save(state, to: file)
    }
  }

  // Only public presentation data crosses this boundary; the selection remains
  // opaque in the app group. A missing style means native system defaults.
  public func getShield(appId: String, policyId: String) throws -> String? {
    try ZoridScreenTimePlan.identifier(policyId)
    return try withState(appId) { state, _ in
      guard let policy = state.policies.first(where: { $0.id == policyId }) else { throw ZoridScreenTimeError.policyMissing }
      guard let style = policy.shield?.style else { return nil }
      return String(decoding: try JSONEncoder().encode(style), as: UTF8.self)
    }
  }

  // The system does not identify which ManagedSettingsStore caused a shield.
  // Choose the first matching active tool in stable app-ID order. No app names,
  // bundle IDs or opaque tokens are returned to JavaScript or persisted here.
  public func shieldStyle(application: ApplicationToken? = nil, category: ActivityCategoryToken? = nil) -> ZoridShieldStyle {
    guard application != nil || category != nil,
          let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else {
      return .fallback
    }
    let directory = root.appendingPathComponent("ScreenTime", isDirectory: true)
    // ShieldConfigurationDataSource has a restricted sandbox and must respond
    // promptly. Read an existing snapshot only; never create files, update stores,
    // clear expired sessions, or move provided app/category metadata out of it.
    let descriptor = open(directory.appendingPathComponent("controls.lock").path, O_RDONLY | O_CLOEXEC)
    guard descriptor >= 0 else { return .fallback }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_SH | LOCK_NB) == 0 else { return .fallback }
    defer { flock(descriptor, LOCK_UN) }
    guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return .fallback }
    let now = Date().timeIntervalSince1970 * 1000
    for file in files.filter({ $0.pathExtension == "json" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
      guard (try? ZoridScreenTimePlan.identifier(file.deletingPathExtension().lastPathComponent)) != nil,
            let data = try? Data(contentsOf: file),
            let state = try? JSONDecoder().decode(ZoridScreenTimeState.self, from: data),
            let active = state.active, active.endsAt > now,
            let policy = state.policies.first(where: { $0.id == active.policyId }) else { continue }
      guard ZoridShieldMatch.matches(mode: policy.mode, application: application, category: category,
        applications: policy.selection.applicationTokens, categories: policy.selection.categoryTokens) else { continue }
      return policy.shield?.style ?? .fallback
    }
    return .fallback
  }

  public func deletePolicy(appId: String, policyId: String) throws {
    try ZoridScreenTimePlan.identifier(policyId)
    try withState(appId) { state, file in
      if state.active?.policyId == policyId { clearLocked(appId, state: &state) }
      state.policies.removeAll { $0.id == policyId }
      try save(state, to: file)
    }
  }

  public func clear(appId: String) throws {
    try withState(appId) { state, file in
      clearLocked(appId, state: &state)
      try save(state, to: file)
    }
  }

  public func apply(appId: String, command: [String: Any]) throws {
    if let clear = command["clear"] as? NSNumber, CFGetTypeID(clear) == CFBooleanGetTypeID(), clear.boolValue,
       command.count == 1 {
      try self.clear(appId: appId)
      return
    }
    guard Set(command.keys) == Set(["policyId", "sessionId", "endsAt"]),
          let policyId = command["policyId"] as? String, let sessionId = command["sessionId"] as? String,
          let deadline = command["endsAt"] as? NSNumber, CFGetTypeID(deadline) != CFBooleanGetTypeID(),
          deadline.doubleValue.isFinite, deadline.doubleValue > 0, deadline.doubleValue.rounded() == deadline.doubleValue else { throw ZoridScreenTimeError.invalidCommand }
    try ZoridScreenTimePlan.identifier(policyId)
    try ZoridScreenTimePlan.identifier(sessionId)
    try withState(appId) { state, file in
      // Replayed durable effects whose deadline passed must never re-block apps.
      if deadline.doubleValue <= Date().timeIntervalSince1970 * 1000 {
        if let active = state.active,
           active.sessionId == sessionId || active.endsAt <= Date().timeIntervalSince1970 * 1000 {
          clearLocked(appId, state: &state)
          try save(state, to: file)
        }
        return
      }
      guard authorized else {
        clearLocked(appId, state: &state)
        try save(state, to: file)
        throw ZoridScreenTimeError.unavailableAuthorization
      }
      guard let policy = state.policies.first(where: { $0.id == policyId }) else {
        throw ZoridScreenTimeError.policyMissing
      }
      let interval = try ZoridScreenTimePlan.interval(now: Date(), endsAt: deadline.doubleValue)
      let store = settings(appId)
      if let active = state.active, active.sessionId == sessionId, active.policyId == policyId,
         active.endsAt == deadline.doubleValue, center.activities.contains(DeviceActivityName(active.monitor)) {
        shield(policy, store: store)
        return
      }
      clearLocked(appId, state: &state)
      let monitor = "zorid.\(appId).\(UUID().uuidString.lowercased())"
      let active = ZoridScreenTimeActive(policyId: policyId, sessionId: sessionId, endsAt: deadline.doubleValue, monitor: monitor)
      state.active = active
      do {
        // Persist the deadline before scheduling; a concurrent callback waits for
        // this lock and then sees either the completed activation or cleared state.
        try save(state, to: file)
        let calendar = Calendar.current
        let fields: Set<Calendar.Component> = [.era, .year, .month, .day, .hour, .minute, .second]
        // Round up, because DateComponents scheduling has whole-second resolution.
        let end = calendar.dateComponents(fields, from: Date(timeIntervalSince1970: ceil(interval.end.timeIntervalSince1970)))
        let schedule = DeviceActivitySchedule(intervalStart: calendar.dateComponents(fields, from: interval.start),
          intervalEnd: end, repeats: false)
        try center.startMonitoring(DeviceActivityName(monitor), during: schedule)
        shield(policy, store: store)
      } catch {
        clearLocked(appId, state: &state)
        try save(state, to: file)
        throw ZoridScreenTimeError.monitoringFailed
      }
    }
  }

  public func intervalEnded(_ activity: DeviceActivityName) {
    // Activity names are native-generated. Ignore unrelated or obsolete callbacks.
    let raw = activity.rawValue
    guard raw.hasPrefix("zorid."), raw.count > 43 else { return }
    let suffix = String(raw.suffix(36))
    guard UUID(uuidString: suffix) != nil else { return }
    let appId = String(raw.dropFirst(6).dropLast(37))
    try? withState(appId) { state, file in
      guard let active = state.active, active.monitor == raw,
            active.endsAt <= Date().timeIntervalSince1970 * 1000 else { return }
      clearLocked(appId, state: &state)
      try save(state, to: file)
    }
  }

  private var authorized: Bool { AuthorizationCenter.shared.authorizationStatus == .approved }
  private func settings(_ appId: String) -> ManagedSettingsStore {
    ManagedSettingsStore(named: ManagedSettingsStore.Name("zorid.\(appId)"))
  }
  private func shield(_ policy: ZoridScreenTimePolicy, store: ManagedSettingsStore) {
    store.clearAllSettings()
    if policy.mode == "allowlist" {
      store.shield.applicationCategories = .all(except: policy.selection.applicationTokens)
    } else {
      store.shield.applications = policy.selection.applicationTokens.isEmpty ? nil : policy.selection.applicationTokens
      store.shield.applicationCategories = policy.selection.categoryTokens.isEmpty ? nil : .specific(policy.selection.categoryTokens)
    }
  }
  private func clearLocked(_ appId: String, state: inout ZoridScreenTimeState) {
    settings(appId).clearAllSettings()
    if let active = state.active { center.stopMonitoring([DeviceActivityName(active.monitor)]) }
    state.active = nil
  }
  private func save(_ state: ZoridScreenTimeState, to file: URL) throws {
    try JSONEncoder().encode(state).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    var location = file
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try location.setResourceValues(values)
  }
  private func withState<T>(_ appId: String, _ body: (inout ZoridScreenTimeState, URL) throws -> T) throws -> T {
    try ZoridScreenTimePlan.identifier(appId)
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else {
      throw ZoridScreenTimeError.unavailableStorage
    }
    let directory = root.appendingPathComponent("ScreenTime", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let descriptor = open(directory.appendingPathComponent("controls.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw ZoridScreenTimeError.unavailableStorage }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else { throw ZoridScreenTimeError.busy }
    defer { flock(descriptor, LOCK_UN) }
    let file = directory.appendingPathComponent("\(appId).json")
    var state = ZoridScreenTimeState()
    if FileManager.default.fileExists(atPath: file.path) {
      do { state = try JSONDecoder().decode(ZoridScreenTimeState.self, from: Data(contentsOf: file)) }
      catch {
        settings(appId).clearAllSettings()
        center.stopMonitoring(center.activities.filter { $0.rawValue.hasPrefix("zorid.\(appId).") })
        // Failed/corrupt protected data must be reselected; never continue blocking
        // when the selection/deadline can no longer be read.
        throw ZoridScreenTimeError.unavailableStorage
      }
    }
    return try body(&state, file)
  }
}
