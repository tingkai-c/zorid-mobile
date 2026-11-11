import Foundation

// UNNotificationContent.userInfo travels through property-list serialization.
// Keep arbitrary valid JSON (including null) inside a JSON string, never as an
// NSNull-containing property-list value. Only exact owned markers are decoded.
enum ZoridNotificationPayload {
  static let requestPrefix = "zorid.device.notification:"
  static let appKey = "zoridDeviceAppId"
  static let idKey = "zoridDeviceNotificationId"
  static let dataKey = "zoridDeviceDataJSON"
  static let dataLimit = 16_384

  enum Failure: LocalizedError {
    case invalid
    var errorDescription: String? { "Notification identifiers or JSON data are invalid or exceed 16 KiB." }
  }

  static func identifier(_ raw: Any?, max: Int) -> String? {
    guard let value = raw as? String, !value.isEmpty, value.utf8.count <= max,
          value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil else { return nil }
    return value
  }

  static func pack(appId: String, id: String, data: [String: Any]) throws -> [AnyHashable: Any] {
    guard identifier(appId, max: 64) != nil, identifier(id, max: 128) != nil,
          JSONSerialization.isValidJSONObject(data) else { throw Failure.invalid }
    let bytes = try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
    guard bytes.count <= dataLimit else { throw Failure.invalid }
    return [appKey: appId, idKey: id, dataKey: String(decoding: bytes, as: UTF8.self)]
  }

  static func unpack(_ userInfo: [AnyHashable: Any], requestIdentifier: String)
    -> (appId: String, id: String, data: [String: Any])? {
    guard let appId = identifier(userInfo[appKey], max: 64), let id = identifier(userInfo[idKey], max: 128),
          requestIdentifier == requestPrefix + appId + ":" + id,
          let json = userInfo[dataKey] as? String, json.utf8.count <= dataLimit,
          let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
          let data = object as? [String: Any] else { return nil }
    return (appId, id, data)
  }
}
