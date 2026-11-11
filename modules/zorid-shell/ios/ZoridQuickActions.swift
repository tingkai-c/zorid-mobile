import UIKit

/// Dynamic menu items share one installed type. Their IDs resolve against a
/// saved local definition; a caller cannot inject a URL through userInfo.
enum ZoridQuickActions {
  static let shortcutType = "app.zorid.mobile.downloaded-action"
  private static let key = "zorid.quick-actions.v1"

  static func set(appId: String, json: String) throws {
    let items = try ZoridQuickAction.decode(appId: appId, json: json)
    UserDefaults.standard.set(["appId": appId, "items": json], forKey: key)
    apply(appId: appId, items: items)
  }

  static func restore() {
    guard let saved = UserDefaults.standard.dictionary(forKey: key),
      let appId = saved["appId"] as? String, let json = saved["items"] as? String,
      let items = try? ZoridQuickAction.decode(appId: appId, json: json) else {
      UIApplication.shared.shortcutItems = []
      return
    }
    apply(appId: appId, items: items)
  }

  static func handle(_ item: UIApplicationShortcutItem) -> Bool {
    guard item.type == shortcutType,
      let appId = item.userInfo?["appId"] as? String, let id = item.userInfo?["id"] as? String,
      let saved = UserDefaults.standard.dictionary(forKey: key), saved["appId"] as? String == appId,
      let json = saved["items"] as? String,
      let items = try? ZoridQuickAction.decode(appId: appId, json: json),
      let action = items.first(where: { $0.id == id }) else { return false }
    return ZoridRouteQueue.shared.enqueue(action.url, source: "quickAction")
  }

  private static func apply(appId: String, items: [ZoridQuickAction]) {
    UIApplication.shared.shortcutItems = items.map { item in
      UIApplicationShortcutItem(type: shortcutType, localizedTitle: item.title,
        localizedSubtitle: item.subtitle,
        icon: item.systemImage.map { UIApplicationShortcutIcon(systemImageName: $0) },
        userInfo: ["appId": appId as NSString, "id": item.id as NSString])
    }
  }
}
