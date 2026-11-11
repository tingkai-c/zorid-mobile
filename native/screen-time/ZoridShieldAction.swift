import ManagedSettings

final class ZoridShieldAction: ShieldActionDelegate {
  override func handle(action: ShieldAction, for application: ApplicationToken,
                       completionHandler: @escaping (ShieldActionResponse) -> Void) {
    completionHandler(response(action: action, style: ZoridScreenTimeController.shared.shieldStyle(application: application)))
  }
  override func handle(action: ShieldAction, for category: ActivityCategoryToken,
                       completionHandler: @escaping (ShieldActionResponse) -> Void) {
    completionHandler(response(action: action, style: ZoridScreenTimeController.shared.shieldStyle(category: category)))
  }
  override func handle(action: ShieldAction, for webDomain: WebDomainToken,
                       completionHandler: @escaping (ShieldActionResponse) -> Void) {
    completionHandler(.close)
  }
  private func response(action: ShieldAction, style: ZoridShieldStyle) -> ShieldActionResponse {
    if #available(iOS 26.4, *) {
      switch action {
      case .firstSecondarySubmenuItemPressed: return nativeResponse(style.submenuAction(at: 0))
      case .secondSecondarySubmenuItemPressed: return nativeResponse(style.submenuAction(at: 1))
      case .thirdSecondarySubmenuItemPressed: return nativeResponse(style.submenuAction(at: 2))
      default: break
      }
    }
    switch action {
    case .primaryButtonPressed: return nativeResponse(style.action(secondary: false))
    case .secondaryButtonPressed: return nativeResponse(style.action(secondary: true))
    default: return .none
    }
  }
  private func nativeResponse(_ value: String) -> ShieldActionResponse {
    switch value {
    case "close": return .close
    case "defer": return .defer
    case "openApp":
      if #available(iOS 26.5, *) { return .openParentalControlsApp }
      return .none
    default: return .none
    }
  }
}
