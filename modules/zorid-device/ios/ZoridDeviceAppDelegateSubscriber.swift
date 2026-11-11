import ExpoModulesCore
import UIKit

public final class ZoridDeviceAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    ZoridDeviceNotifications.shared.install()
    return true
  }
}
