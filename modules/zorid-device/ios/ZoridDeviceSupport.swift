import Foundation

enum ZoridDeviceError: LocalizedError {
  case invalid(String), unsupported(String), failure(String)

  var errorDescription: String? {
    switch self {
    case .invalid(let message), .unsupported(let message), .failure(let message): return message
    }
  }
}

enum ZoridDeviceJSON {
  static let byteLimit = 8 * 1024 * 1024

  static func object(_ json: String, keys: Set<String>? = nil) throws -> [String: Any] {
    guard json.utf8.count <= byteLimit,
          let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
          let object = value as? [String: Any],
          keys.map({ Set(object.keys).isSubset(of: $0) }) ?? true else {
      throw ZoridDeviceError.invalid("Invalid device request or unsupported fields.")
    }
    return object
  }

  static func encode(_ value: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
    guard data.count <= byteLimit else { throw ZoridDeviceError.failure("Device response exceeds the transport limit.") }
    return String(decoding: data, as: UTF8.self)
  }

  // The deployed app is trusted code. Restrict file-consuming APIs to actual
  // readable files in its sandbox/shared container, never network URLs.
  static func localFile(_ raw: String) throws -> URL {
    guard let input = URL(string: raw), input.isFileURL,
          input.query == nil, input.fragment == nil,
          input.host == nil || input.host == "" || input.host == "localhost" else {
      throw ZoridDeviceError.invalid("Use a local file URL in Zorid's container.")
    }
    let url = input.standardizedFileURL.resolvingSymlinksInPath()
    var roots = [URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)]
    if let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.zorid.mobile") {
      roots.append(shared)
    }
    guard roots.contains(where: {
      let path = $0.standardizedFileURL.resolvingSymlinksInPath().path
      return url.path.hasPrefix(path + "/")
    }), (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
      FileManager.default.isReadableFile(atPath: url.path) else {
      throw ZoridDeviceError.invalid("Use a readable file in Zorid's container.")
    }
    return url
  }
}
