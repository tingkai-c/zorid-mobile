import Foundation
import SQLite3
import Darwin

public struct ZoridActionError: LocalizedError {
  public let message: String
  public var errorDescription: String? { message }
  init(_ message: String) { self.message = message }
}

func actionJSON(_ value: Any) throws -> String {
  let data: Data
  do {
    data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
  } catch {
    throw ZoridActionError("Action values must be JSON-serializable data.")
  }
  guard data.count <= 1_048_576, let text = String(data: data, encoding: .utf8) else {
    throw ZoridActionError("Action JSON exceeds its size limit.")
  }
  return text
}

func actionParse(_ text: String) throws -> Any {
  guard let data = text.data(using: .utf8), data.count <= 1_048_576 else {
    throw ZoridActionError("Action JSON exceeds its size limit.")
  }
  do {
    return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  } catch {
    throw ZoridActionError("Invalid action JSON.")
  }
}

func actionIdentifier(_ value: String, maximum: Int = 128) throws {
  guard !value.isEmpty, value.utf8.count <= maximum,
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil else {
    throw ZoridActionError("Invalid action identifier.")
  }
}

final class ZoridActionConnection {
  private(set) var handle: OpaquePointer?
  private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  init(url: URL, readOnly: Bool = false) throws {
    let flags = (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK else {
      if let handle { sqlite3_close(handle) }
      handle = nil
      throw ZoridActionError("Unable to open shared action storage.")
    }
    sqlite3_busy_timeout(handle, 1_000)
  }

  deinit { sqlite3_close(handle) }

  func execute(_ sql: String, _ values: [Any] = []) throws {
    try statement(sql, values) { statement in
      guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError() }
    }
  }

  func script(_ sql: String) throws {
    guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { throw databaseError() }
  }

  func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
    try statement(sql, values) { statement in
      var rows: [[String: Any]] = []
      while true {
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return rows }
        guard result == SQLITE_ROW else { throw databaseError() }
        var row: [String: Any] = [:]
        for index in 0..<sqlite3_column_count(statement) {
          let name = String(cString: sqlite3_column_name(statement, index))
          switch sqlite3_column_type(statement, index) {
          case SQLITE_INTEGER: row[name] = sqlite3_column_int64(statement, index)
          case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, index)
          case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(statement, index))
          default: row[name] = NSNull()
          }
        }
        rows.append(row)
      }
    }
  }

  func transaction<T>(_ body: () throws -> T) throws -> T {
    try execute("BEGIN IMMEDIATE")
    do {
      let result = try body()
      try execute("COMMIT")
      return result
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }

  private func statement<T>(_ sql: String, _ values: [Any], _ body: (OpaquePointer) throws -> T) throws -> T {
    var prepared: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else { throw databaseError() }
    defer { sqlite3_finalize(prepared) }
    for (offset, value) in values.enumerated() {
      let index = Int32(offset + 1)
      let result: Int32
      if value is NSNull { result = sqlite3_bind_null(prepared, index) }
      else if let text = value as? String { result = sqlite3_bind_text(prepared, index, text, -1, transient) }
      else if let number = value as? NSNumber { result = sqlite3_bind_double(prepared, index, number.doubleValue) }
      else { throw ZoridActionError("Unsupported action storage parameter.") }
      guard result == SQLITE_OK else { throw databaseError() }
    }
    return try body(prepared)
  }

  private func databaseError() -> ZoridActionError {
    // No raw query, record, token, or personal payload appears in errors or logs.
    let code = sqlite3_errcode(handle)
    return ZoridActionError(code == SQLITE_BUSY || code == SQLITE_LOCKED ? "Shared storage is busy. Retry the action." : "Shared action storage failed (SQLite \(code)).")
  }
}

final class ZoridActionStore {
  let directoryOverride: URL?
  private let legacyDirectoryOverride: URL?
  private let isExtension: Bool

  init(directoryURL: URL? = nil, legacyDirectoryURL: URL? = nil, isExtension: Bool = Bundle.main.bundleURL.pathExtension == "appex") {
    directoryOverride = directoryURL
    legacyDirectoryOverride = legacyDirectoryURL
    self.isExtension = isExtension
  }

  func directory() throws -> URL {
    if let directoryOverride { return directoryOverride }
    guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.zorid.mobile") else {
      throw ZoridActionError("The installed binary has no shared action storage entitlement.")
    }
    return group.appendingPathComponent("SQLite", isDirectory: true)
  }

  func prepare(legacyDirectory: String?) throws -> String {
    let directory = try directory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // Serialize first creation and WAL-safe migration across app/extension processes.
    let lock = open(directory.appendingPathComponent(".migration.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard lock >= 0 else { throw ZoridActionError("Unable to lock shared storage setup.") }
    defer { flock(lock, LOCK_UN); close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw ZoridActionError("Shared storage setup is busy. Retry shortly.") }
    let target = directory.appendingPathComponent("zorid.db")
    if !FileManager.default.fileExists(atPath: target.path) {
      // The extension cannot inspect the app's Documents container. It must wait for
      // app bootstrap rather than creating an empty database ahead of migration.
      guard !isExtension else { throw ZoridActionError("Open Zorid once to prepare shared action storage.") }
      let legacyURL: URL?
      if let legacyDirectory {
        legacyURL = legacyDirectory.hasPrefix("file:") ? URL(string: legacyDirectory) : URL(fileURLWithPath: legacyDirectory)
        guard legacyURL?.isFileURL == true else { throw ZoridActionError("Invalid legacy storage directory.") }
      } else if let legacyDirectoryOverride {
        legacyURL = legacyDirectoryOverride
      } else if directoryOverride == nil {
        // Expo SQLite's iOS default is Documents/SQLite. Detect it even when an
        // action bundle installs before JavaScript calls prepareDatabase explicitly.
        legacyURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("SQLite", isDirectory: true)
      } else {
        legacyURL = nil
      }
      if let source = legacyURL?.appendingPathComponent("zorid.db"),
         FileManager.default.fileExists(atPath: source.path), source.standardizedFileURL != target.standardizedFileURL {
        try migrate(source: source, target: target)
      }
    }
    let connection = try ZoridActionConnection(url: target)
    try connection.script("""
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS documents (
        feature TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
        schema_version INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(feature, collection, id));
      CREATE TABLE IF NOT EXISTS zorid_action_bundles (
        app_id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS zorid_action_bundle_versions (
        app_id TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL,
        PRIMARY KEY(app_id, version));
      CREATE TABLE IF NOT EXISTS zorid_action_receipts (
        app_id TEXT NOT NULL, invocation_id TEXT NOT NULL, request TEXT NOT NULL,
        response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(app_id, invocation_id));
      CREATE TABLE IF NOT EXISTS zorid_action_effects (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, app_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS zorid_action_outbox (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS zorid_action_effects_owner ON zorid_action_effects(app_id, invocation_id);
      CREATE INDEX IF NOT EXISTS zorid_action_outbox_owner ON zorid_action_outbox(app_id);
      """)
    #if os(iOS)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
    #endif
    return directory.path
  }

  func connect() throws -> ZoridActionConnection {
    _ = try prepare(legacyDirectory: nil)
    return try ZoridActionConnection(url: directory().appendingPathComponent("zorid.db"))
  }

  private func migrate(source: URL, target: URL) throws {
    let temporary = target.deletingLastPathComponent().appendingPathComponent("migration-\(UUID().uuidString).db")
    defer { try? FileManager.default.removeItem(at: temporary) }
    do {
      let original = try ZoridActionConnection(url: source, readOnly: true)
      let destination = try ZoridActionConnection(url: temporary)
      guard let backup = sqlite3_backup_init(destination.handle, "main", original.handle, "main") else {
        throw ZoridActionError("Unable to prepare the existing-record migration.")
      }
      var result = SQLITE_BUSY
      for _ in 0..<5 {
        result = sqlite3_backup_step(backup, -1)
        if result == SQLITE_DONE { break }
        if result != SQLITE_BUSY && result != SQLITE_LOCKED { break }
        usleep(20_000)
      }
      let finish = sqlite3_backup_finish(backup)
      guard result == SQLITE_DONE, finish == SQLITE_OK else {
        throw ZoridActionError("Existing records could not be migrated. The original has been preserved.")
      }
      guard (try destination.rows("PRAGMA quick_check").first?["quick_check"] as? String) == "ok" else {
        throw ZoridActionError("Existing storage failed its integrity check. The original has been preserved.")
      }
    }
    try FileManager.default.moveItem(at: temporary, to: target)
  }
}
