import Foundation
import UserNotifications
import CoreFoundation

// Main-queue state. Native callbacks capture responses before React is ready.
// Background actions are receipts for later application processing, not a JS job.
final class ZoridDeviceNotifications: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ZoridDeviceNotifications()
  private let center = UNUserNotificationCenter.current()
  private weak var previousDelegate: UNUserNotificationCenterDelegate?
  private var categoryJobs: [(String, Set<UNNotificationCategory>, (Result<String, Error>) -> Void)] = []
  private var updatingCategories = false
  private lazy var responseStore = ZoridNotificationResponseStore(url: responseURL)
  private let requestPrefix = ZoridNotificationPayload.requestPrefix
  private let categoryPrefix = "zorid.device.category:"
  private override init() { super.init() }

  func install() {
    if center.delegate !== self {
      previousDelegate = center.delegate
      center.delegate = self
    }
  }

  func call(_ operation: String, json: String, completion: @escaping (Result<String, Error>) -> Void) {
    do {
      install()
      switch operation {
      case "status":
        _ = try ZoridDeviceJSON.object(json, keys: [])
        settings(completion: completion)
      case "request":
        let value = try ZoridDeviceJSON.object(json, keys: ["alert", "sound", "badge", "provisional"])
        var options: UNAuthorizationOptions = []
        if try bool(value["alert"], default: true) { options.insert(.alert) }
        if try bool(value["sound"], default: true) { options.insert(.sound) }
        if try bool(value["badge"], default: true) { options.insert(.badge) }
        if try bool(value["provisional"], default: false) { options.insert(.provisional) }
        center.requestAuthorization(options: options) { granted, error in
          DispatchQueue.main.async {
            if let error { completion(.failure(error)); return }
            self.settings(granted: granted, completion: completion)
          }
        }
      case "categories":
        let value = try ZoridDeviceJSON.object(json, keys: ["appId", "categories"])
        let appId = try identifier(value["appId"], max: 64)
        let categories = try makeCategories(value["categories"], appId: appId)
        categoryJobs.append((appId, categories, completion))
        updateNextCategories()
      case "schedule":
        let value = try ZoridDeviceJSON.object(json, keys: ["appId", "id", "title", "subtitle", "body", "sound", "badge", "categoryId", "data", "trigger"])
        let appId = try identifier(value["appId"], max: 64)
        let id = try identifier(value["id"], max: 128)
        let content = UNMutableNotificationContent()
        content.title = try text(value["title"], default: "")
        content.subtitle = try text(value["subtitle"], default: "")
        content.body = try text(value["body"], default: "")
        if let sound = value["sound"], !(sound is NSNull) {
          guard sound as? String == "default" else { throw ZoridDeviceError.invalid("Notification sound must be default or null.") }
          content.sound = .default
        }
        if let badge = value["badge"], !(badge is NSNull) {
          content.badge = NSNumber(value: try integer(badge, min: 0, max: Int32.max))
        }
        if let raw = value["categoryId"] {
          content.categoryIdentifier = categoryNamespace(appId) + (try identifier(raw, max: 128))
        }
        let data: [String: Any]
        if let raw = value["data"] { data = try object(raw, keys: nil) } else { data = [:] }
        content.userInfo = try ZoridNotificationPayload.pack(appId: appId, id: id, data: data)
        let trigger = try makeTrigger(value["trigger"])
        let request = UNNotificationRequest(identifier: namespace(appId) + id, content: content, trigger: trigger)
        center.add(request) { error in
          DispatchQueue.main.async {
            do {
              if let error { throw error }
              completion(.success(try ZoridDeviceJSON.encode(["id": id])))
            } catch { completion(.failure(error)) }
          }
        }
      case "pending", "delivered":
        let value = try ZoridDeviceJSON.object(json, keys: ["appId"])
        let appId = try identifier(value["appId"], max: 64)
        if operation == "pending" {
          center.getPendingNotificationRequests { requests in
            DispatchQueue.main.async {
              self.reply(completion) { ["notifications": requests.compactMap { self.notification($0, appId: appId) }] }
            }
          }
        } else {
          center.getDeliveredNotifications { notifications in
            DispatchQueue.main.async {
              self.reply(completion) {
                ["notifications": notifications.compactMap { notification -> [String: Any]? in
                  guard var result = self.notification(notification.request, appId: appId) else { return nil }
                  result["deliveredAt"] = notification.date.timeIntervalSince1970 * 1000
                  return result
                }]
              }
            }
          }
        }
      case "cancel", "removeDelivered":
        let value = try ZoridDeviceJSON.object(json, keys: ["appId", "ids"])
        let appId = try identifier(value["appId"], max: 64)
        if let raw = value["ids"] {
          let ids = try identifiers(raw, maxCount: 256).map { namespace(appId) + $0 }
          if operation == "cancel" { center.removePendingNotificationRequests(withIdentifiers: ids) }
          else { center.removeDeliveredNotifications(withIdentifiers: ids) }
          completion(.success(try ZoridDeviceJSON.encode(["removed": true])))
        } else if operation == "cancel" {
          center.getPendingNotificationRequests { requests in
            DispatchQueue.main.async {
              let ids = requests.filter { self.notification($0, appId: appId) != nil }.map(\.identifier)
              self.center.removePendingNotificationRequests(withIdentifiers: ids)
              self.reply(completion) { ["removed": true] }
            }
          }
        } else {
          center.getDeliveredNotifications { notifications in
            DispatchQueue.main.async {
              let ids = notifications.filter { self.notification($0.request, appId: appId) != nil }.map { $0.request.identifier }
              self.center.removeDeliveredNotifications(withIdentifiers: ids)
              self.reply(completion) { ["removed": true] }
            }
          }
        }
      case "responses":
        let value = try ZoridDeviceJSON.object(json, keys: ["appId"])
        let appId = try identifier(value["appId"], max: 64)
        let items = responseStore.pending(appId: appId)
        completion(.success(try ZoridDeviceJSON.encode(["responses": items,
          "persistenceError": responseStore.persistenceError, "overflowed": responseStore.overflowed])))
      case "acknowledge":
        let value = try ZoridDeviceJSON.object(json, keys: ["appId", "ids"])
        let appId = try identifier(value["appId"], max: 64)
        let ids = Set(try identifiers(value["ids"], maxCount: 128))
        try responseStore.acknowledge(appId: appId, ids: ids)
        completion(.success(try ZoridDeviceJSON.encode(["acknowledged": true])))
      default: throw ZoridDeviceError.unsupported("Unknown notification operation.")
      }
    } catch { completion(.failure(error)) }
  }

  private func settings(granted: Bool? = nil, completion: @escaping (Result<String, Error>) -> Void) {
    center.getNotificationSettings { settings in
      DispatchQueue.main.async {
        self.reply(completion) {
          let authorization: String
          switch settings.authorizationStatus {
          case .notDetermined: authorization = "notDetermined"
          case .denied: authorization = "denied"
          case .authorized: authorization = "authorized"
          case .provisional: authorization = "provisional"
          case .ephemeral: authorization = "ephemeral"
          @unknown default: authorization = "unknown"
          }
          var result: [String: Any] = ["authorization": authorization,
            "alert": settings.alertSetting == .enabled, "sound": settings.soundSetting == .enabled,
            "badge": settings.badgeSetting == .enabled, "lockScreen": settings.lockScreenSetting == .enabled,
            "notificationCenter": settings.notificationCenterSetting == .enabled]
          if let granted { result["granted"] = granted }
          return result
        }
      }
    }
  }

  private func makeCategories(_ raw: Any?, appId: String) throws -> Set<UNNotificationCategory> {
    guard let raw = raw as? [Any], raw.count <= 64 else { throw ZoridDeviceError.invalid("Provide at most 64 notification categories.") }
    var categories = Set<UNNotificationCategory>()
    var categoryIds = Set<String>()
    for item in raw {
      let value = try object(item, keys: ["id", "actions"])
      let id = try identifier(value["id"], max: 128)
      guard categoryIds.insert(id).inserted, let rawActions = value["actions"] as? [Any], rawActions.count <= 4 else {
        throw ZoridDeviceError.invalid("Category identifiers must be unique and contain at most four actions.")
      }
      var actionIds = Set<String>()
      var actions: [UNNotificationAction] = []
      for item in rawActions {
        let action = try object(item, keys: ["id", "title", "options", "textInput"])
        let actionId = try identifier(action["id"], max: 128)
        guard actionId != "default", actionId != "dismiss", actionIds.insert(actionId).inserted else {
          throw ZoridDeviceError.invalid("Action identifiers must be unique; default and dismiss are reserved.")
        }
        let title = try text(action["title"], default: nil)
        var options: UNNotificationActionOptions = []
        if let rawOptions = action["options"] {
          guard let rawOptions = rawOptions as? [String], rawOptions.count <= 3,
                Set(rawOptions).count == rawOptions.count else { throw ZoridDeviceError.invalid("Invalid notification action options.") }
          for option in rawOptions {
            switch option {
            case "foreground": options.insert(.foreground)
            case "destructive": options.insert(.destructive)
            case "authenticationRequired": options.insert(.authenticationRequired)
            default: throw ZoridDeviceError.invalid("Unknown notification action option.")
            }
          }
        }
        let native: UNNotificationAction
        if let input = action["textInput"] {
          let input = try object(input, keys: ["buttonTitle", "placeholder"])
          native = UNTextInputNotificationAction(identifier: actionId, title: title, options: options,
            textInputButtonTitle: try text(input["buttonTitle"], default: nil),
            textInputPlaceholder: try text(input["placeholder"], default: ""))
        } else { native = UNNotificationAction(identifier: actionId, title: title, options: options) }
        actions.append(native)
      }
      categories.insert(UNNotificationCategory(identifier: categoryNamespace(appId) + id,
        actions: actions, intentIdentifiers: [], options: [.customDismissAction]))
    }
    return categories
  }

  private func updateNextCategories() {
    guard !updatingCategories, !categoryJobs.isEmpty else { return }
    updatingCategories = true
    let (appId, replacements, completion) = categoryJobs.removeFirst()
    center.getNotificationCategories { existing in
      DispatchQueue.main.async {
        var categories = Set(existing.filter { !$0.identifier.hasPrefix(self.categoryNamespace(appId)) })
        categories.formUnion(replacements)
        self.center.setNotificationCategories(categories)
        self.reply(completion) { ["registered": true] }
        self.updatingCategories = false
        self.updateNextCategories()
      }
    }
  }

  private func makeTrigger(_ raw: Any?) throws -> UNNotificationTrigger {
    let value = try object(raw, keys: ["type", "at", "seconds", "repeats", "components"])
    switch value["type"] as? String {
    case "date":
      guard Set(value.keys).isSubset(of: ["type", "at"]) else { throw ZoridDeviceError.invalid("Date triggers accept only at.") }
      let at = try number(value["at"])
      guard at > Date().timeIntervalSince1970 * 1000, at <= 253_402_300_799_000 else {
        throw ZoridDeviceError.invalid("Notification date must be a future epoch-millisecond timestamp before year 10000.")
      }
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = TimeZone(secondsFromGMT: 0)!
      var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: Date(timeIntervalSince1970: ceil(at / 1000)))
      components.calendar = calendar
      components.timeZone = calendar.timeZone
      let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
      guard trigger.nextTriggerDate() != nil else { throw ZoridDeviceError.invalid("Notification date has no next occurrence.") }
      return trigger
    case "delay":
      guard Set(value.keys).isSubset(of: ["type", "seconds", "repeats"]) else { throw ZoridDeviceError.invalid("Delay triggers accept only seconds and repeats.") }
      let seconds = try number(value["seconds"])
      let repeats = try bool(value["repeats"], default: false)
      guard seconds > 0, seconds <= 31_536_000_000, !repeats || seconds >= 60 else {
        throw ZoridDeviceError.invalid("Notification delay must be positive; repeating delays need at least 60 seconds.")
      }
      return UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: repeats)
    case "calendar":
      guard Set(value.keys).isSubset(of: ["type", "components", "repeats"]) else { throw ZoridDeviceError.invalid("Calendar triggers accept only components and repeats.") }
      let values = try object(value["components"], keys: ["year", "month", "day", "weekday", "hour", "minute", "second"])
      guard !values.isEmpty else { throw ZoridDeviceError.invalid("Calendar triggers need at least one component.") }
      var components = DateComponents()
      let ranges: [(String, Calendar.Component, Int, Int32)] = [
        ("year", .year, 1, 9999), ("month", .month, 1, 12), ("day", .day, 1, 31),
        ("weekday", .weekday, 1, 7), ("hour", .hour, 0, 23), ("minute", .minute, 0, 59), ("second", .second, 0, 59)]
      for (key, component, min, max) in ranges {
        if let raw = values[key] { components.setValue(try integer(raw, min: min, max: max), for: component) }
      }
      let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: try bool(value["repeats"], default: false))
      guard trigger.nextTriggerDate() != nil else { throw ZoridDeviceError.invalid("Calendar notification has no next occurrence.") }
      return trigger
    default: throw ZoridDeviceError.invalid("Choose a date, delay or calendar notification trigger.")
    }
  }

  private func notification(_ request: UNNotificationRequest, appId: String) -> [String: Any]? {
    guard let payload = ZoridNotificationPayload.unpack(request.content.userInfo, requestIdentifier: request.identifier),
          payload.appId == appId else { return nil }
    let content = request.content
    let category = content.categoryIdentifier.hasPrefix(categoryNamespace(appId))
      ? String(content.categoryIdentifier.dropFirst(categoryNamespace(appId).count)) : ""
    var result: [String: Any] = ["id": payload.id, "title": content.title, "subtitle": content.subtitle,
      "body": content.body, "categoryId": category, "data": payload.data]
    if let at = request.trigger?.nextTriggerDate() { result["nextTriggerAt"] = at.timeIntervalSince1970 * 1000 }
    return result
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    DispatchQueue.main.async {
      if self.ownedApp(notification.request) != nil { completionHandler([.banner, .list, .sound, .badge]) }
      else if let previous = self.previousDelegate,
              previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
        previous.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
      } else { completionHandler([]) }
    }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void) {
    DispatchQueue.main.async {
      let request = response.notification.request
      guard let payload = ZoridNotificationPayload.unpack(request.content.userInfo, requestIdentifier: request.identifier) else {
        if let previous = self.previousDelegate,
           previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
          previous.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
        } else { completionHandler() }
        return
      }
      let action: String
      switch response.actionIdentifier {
      case UNNotificationDefaultActionIdentifier: action = "default"
      case UNNotificationDismissActionIdentifier: action = "dismiss"
      default: action = response.actionIdentifier
      }
      var receipt: [String: Any] = ["id": UUID().uuidString, "appId": payload.appId,
        "notificationId": payload.id, "actionId": action, "data": payload.data,
        "receivedAt": Date().timeIntervalSince1970 * 1000]
      if let text = response as? UNTextInputNotificationResponse {
        let bytes = Data(text.userText.utf8)
        receipt["text"] = bytes.count <= 65_536 ? text.userText : String(decoding: bytes.prefix(65_536), as: UTF8.self)
        if bytes.count > 65_536 { receipt["textTruncated"] = true }
      }
      self.responseStore.append(receipt)
      completionHandler()
    }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
    DispatchQueue.main.async {
      self.previousDelegate?.userNotificationCenter?(center, openSettingsFor: notification)
    }
  }

  private func ownedApp(_ request: UNNotificationRequest) -> String? {
    ZoridNotificationPayload.unpack(request.content.userInfo, requestIdentifier: request.identifier)?.appId
  }

  private var responseURL: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ZoridDevice", isDirectory: true).appendingPathComponent("notification-responses.json")
  }

  private func namespace(_ appId: String) -> String { requestPrefix + appId + ":" }
  private func categoryNamespace(_ appId: String) -> String { categoryPrefix + appId + ":" }

  private func identifier(_ raw: Any?, max: Int) throws -> String {
    guard let value = ZoridNotificationPayload.identifier(raw, max: max) else {
      throw ZoridDeviceError.invalid("Use a stable alphanumeric identifier with dots, underscores or hyphens.")
    }
    return value
  }

  private func identifiers(_ raw: Any?, maxCount: Int) throws -> [String] {
    guard let values = raw as? [Any], values.count <= maxCount else { throw ZoridDeviceError.invalid("Invalid notification identifier list.") }
    return try values.map { try identifier($0, max: 128) }
  }

  private func object(_ raw: Any?, keys: Set<String>?) throws -> [String: Any] {
    guard let value = raw as? [String: Any], keys == nil || Set(value.keys).isSubset(of: keys!) else {
      throw ZoridDeviceError.invalid("Invalid notification object or unknown fields.")
    }
    return value
  }

  private func text(_ raw: Any?, default fallback: String?) throws -> String {
    if raw == nil, let fallback { return fallback }
    guard let value = raw as? String, value.utf8.count <= 16_384 else {
      throw ZoridDeviceError.invalid("Notification text must be at most 16 KiB per field.")
    }
    return value
  }

  private func bool(_ raw: Any?, default fallback: Bool) throws -> Bool {
    guard let raw else { return fallback }
    guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
      throw ZoridDeviceError.invalid("Notification flags must be Boolean values.")
    }
    return number.boolValue
  }

  private func number(_ raw: Any?) throws -> Double {
    guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
      throw ZoridDeviceError.invalid("Notification numbers must be finite.")
    }
    return value.doubleValue
  }

  private func integer(_ raw: Any?, min: Int, max: Int32) throws -> Int {
    let value = try number(raw)
    guard value.rounded(.towardZero) == value, value >= Double(min), value <= Double(max) else {
      throw ZoridDeviceError.invalid("Notification integer is out of range.")
    }
    return Int(value)
  }

  private func reply(_ completion: (Result<String, Error>) -> Void, _ value: () throws -> Any) {
    do { completion(.success(try ZoridDeviceJSON.encode(value()))) }
    catch { completion(.failure(error)) }
  }
}
