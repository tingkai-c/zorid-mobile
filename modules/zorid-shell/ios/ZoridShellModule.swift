import ExpoModulesCore
import Foundation

public final class ZoridShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ZoridShell")
    Events("onRoute")

    OnStartObserving("onRoute") {
      NotificationCenter.default.addObserver(self, selector: #selector(self.routeQueueChanged),
        name: ZoridRouteQueue.changed, object: nil)
    }
    OnStopObserving("onRoute") {
      NotificationCenter.default.removeObserver(self, name: ZoridRouteQueue.changed, object: nil)
    }
    OnDestroy {
      NotificationCenter.default.removeObserver(self)
    }

    AsyncFunction("setQuickActions") { (appId: String, json: String) in
      try ZoridQuickActions.set(appId: appId, json: json)
    }.runOnQueue(.main)

    AsyncFunction("pendingRoutes") { () -> String in
      try ZoridRouteQueue.shared.pending()
    }
    AsyncFunction("acknowledgeRoute") { (id: String) in
      ZoridRouteQueue.shared.acknowledge(id)
    }

    AsyncFunction("openSettings") { () -> Bool in
      ZoridShellCoordinator.shared.openSettings()
    }.runOnQueue(.main)
  }

  @objc private func routeQueueChanged() {
    sendEvent("onRoute", [:])
  }
}
