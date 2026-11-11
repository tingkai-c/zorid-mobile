import Foundation
import ExpoModulesCore

public final class ZoridActionsModule: Module {
  private var changeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("ZoridActions")
    Events("onRecordsChanged")
    OnStartObserving {
      self.changeObserver = NotificationCenter.default.addObserver(forName: ZoridActionRuntime.recordsChangedNotification, object: nil, queue: .main) { [weak self] notification in
        self?.sendEvent("onRecordsChanged", ["appId": notification.userInfo?["appId"] as? String ?? ""])
      }
    }
    OnStopObserving {
      if let observer = self.changeObserver { NotificationCenter.default.removeObserver(observer) }
      self.changeObserver = nil
    }
    OnDestroy {
      if let observer = self.changeObserver { NotificationCenter.default.removeObserver(observer) }
      self.changeObserver = nil
    }
    AsyncFunction("prepareDatabase") { (legacyDirectory: String?) -> String in
      try ZoridActionRuntime.shared.prepareDatabase(legacyDirectory: legacyDirectory)
    }
    AsyncFunction("installBundle") { (json: String) in
      try ZoridActionRuntime.shared.installBundle(json)
    }
    AsyncFunction("dispatch") { (json: String) -> String in
      try ZoridActionRuntime.shared.dispatch(json)
    }
    AsyncFunction("pendingEffects") { (appId: String) -> String in
      try ZoridActionRuntime.shared.pendingEffects(appId: appId)
    }
    AsyncFunction("acknowledgeEffects") { (ids: [String]) in
      try ZoridActionRuntime.shared.acknowledgeEffects(ids: ids)
    }
    AsyncFunction("readOutbox") { (appId: String) -> String in
      try ZoridActionRuntime.shared.readOutbox(appId: appId)
    }
    AsyncFunction("acknowledgeOutbox") { (appId: String, ids: [String]) in
      try ZoridActionRuntime.shared.acknowledgeOutbox(appId: appId, ids: ids)
    }
  }
}
