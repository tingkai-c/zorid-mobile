import Foundation
import Security

struct ZoridPairedHost: Codable {
  let deviceId: String
  let token: String
  let hostName: String
  let updateUrl: String
}

enum ZoridPairingFailure: Error {
  case invalidLink, wrongHost, invalidResponse, storage

  var message: String {
    switch self {
    case .invalidLink: return "Paste a valid Zorid pairing link from your host."
    case .wrongHost: return "This pairing link belongs to a different host than this installed app."
    case .invalidResponse: return "The host returned an invalid pairing response. Check your host configuration."
    case .storage: return "The connection could not be saved securely. Generate a fresh pairing code and try again."
    }
  }
}

enum ZoridPairing {
  static func matches(_ value: String, _ pattern: String) -> Bool {
    guard let match = value.range(of: pattern, options: .regularExpression) else { return false }
    return match == value.startIndex..<value.endIndex
  }

  static func origin(_ value: String, updateEndpoint: Bool = false) -> String? {
    guard var parts = URLComponents(string: value),
      parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      updateEndpoint ? parts.path == "/updates" : (parts.path.isEmpty || parts.path == "/")
    else { return nil }
    if let port = parts.port, !(0...65535).contains(port) { return nil }
    parts.scheme = "https"
    parts.host = host.lowercased()
    if parts.port == 443 { parts.port = nil }
    parts.path = ""
    return parts.string
  }

  static func installedOrigin() -> String? {
    guard let url = Bundle.main.url(forResource: "Expo", withExtension: "plist"),
      let data = try? Data(contentsOf: url),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
      let endpoint = plist["EXUpdatesURL"] as? String
    else { return nil }
    return origin(endpoint, updateEndpoint: true)
  }

  static func offer(_ value: String, trustedOrigin: String) throws -> String {
    guard value.count <= 4096,
      let parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      parts.scheme?.lowercased() == "zorid", parts.host?.lowercased() == "pair",
      parts.path.isEmpty, parts.fragment == nil, parts.user == nil, parts.password == nil,
      parts.port == nil, let items = parts.queryItems, items.count == 2,
      items.filter({ $0.name == "url" }).count == 1,
      items.filter({ $0.name == "token" }).count == 1,
      let suppliedOrigin = items.first(where: { $0.name == "url" })?.value,
      let token = items.first(where: { $0.name == "token" })?.value,
      matches(token, "^[A-Za-z0-9_-]{32,128}$")
    else { throw ZoridPairingFailure.invalidLink }
    guard origin(suppliedOrigin) == trustedOrigin else { throw ZoridPairingFailure.wrongHost }
    return token
  }

  static func validate(_ host: ZoridPairedHost, origin: String) throws -> ZoridPairedHost {
    guard matches(host.deviceId, "^[A-Za-z0-9-]{1,100}$"),
      matches(host.token, "^[A-Za-z0-9_-]{32,128}$"),
      !host.hostName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      host.hostName.count <= 100, host.updateUrl == "\(origin)/updates"
    else { throw ZoridPairingFailure.invalidResponse }
    return host
  }
}

enum ZoridCredentialStore {
  private static let key = Data("zorid.pairedHost.v1".utf8)
  private static let services = ["app:no-auth", "app"]

  private static func query(_ service: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrGeneric as String: key,
     kSecAttrAccount as String: key]
  }

  static func load(origin: String) throws -> ZoridPairedHost? {
    for service in services {
      var lookup = query(service)
      lookup[kSecReturnData as String] = true
      lookup[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: CFTypeRef?
      let status = SecItemCopyMatching(lookup as CFDictionary, &result)
      if status == errSecItemNotFound { continue }
      guard status == errSecSuccess, let data = result as? Data else { throw ZoridPairingFailure.storage }
      guard let decoded = try? JSONDecoder().decode(ZoridPairedHost.self, from: data) else {
        throw ZoridPairingFailure.invalidResponse
      }
      let host = try ZoridPairing.validate(decoded, origin: origin)
      if service == "app" { try save(host) }
      return host
    }
    return nil
  }

  static func save(_ host: ZoridPairedHost) throws {
    let data = try JSONEncoder().encode(host)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
    let base = query(services[0])
    var insertion = base
    attributes.forEach { insertion[$0.key] = $0.value }
    var status = SecItemAdd(insertion as CFDictionary, nil)
    if status == errSecDuplicateItem {
      status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
    }
    guard status == errSecSuccess else { throw ZoridPairingFailure.storage }
    SecItemDelete(query(services[1]) as CFDictionary)
  }

  static func clear() throws {
    for service in services {
      let status = SecItemDelete(query(service) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw ZoridPairingFailure.storage }
    }
  }
}

// Credentials must never be forwarded to a redirect destination, including another path
// on the same host. Rejecting redirects also makes the trusted endpoint explicit.
final class ZoridNoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
