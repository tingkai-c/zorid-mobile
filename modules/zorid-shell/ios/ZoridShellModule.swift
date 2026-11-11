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
      DispatchQueue.main.async {
        ZoridHaptics.shared.reset()
        ZoridCoreHaptics.shared.reset()
      }
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

    AsyncFunction("hapticsStatus") { () -> String in
      try ZoridHaptics.shared.status()
    }.runOnQueue(.main)
    AsyncFunction("impact") { (style: String, intensity: Double?, pointJSON: String?) in
      try ZoridHaptics.shared.impact(style: style, intensity: intensity, pointJSON: pointJSON)
    }.runOnQueue(.main)
    AsyncFunction("selection") { (pointJSON: String?) in
      try ZoridHaptics.shared.selection(pointJSON: pointJSON)
    }.runOnQueue(.main)
    AsyncFunction("notification") { (type: String, pointJSON: String?) in
      try ZoridHaptics.shared.notification(type: type, pointJSON: pointJSON)
    }.runOnQueue(.main)
    AsyncFunction("prepareHaptics") { (kind: String, style: String?) in
      try ZoridHaptics.shared.prepare(kind: kind, style: style)
    }.runOnQueue(.main)
    AsyncFunction("resetHaptics") {
      ZoridHaptics.shared.reset()
    }.runOnQueue(.main)
    AsyncFunction("coreHapticsStatus") { () -> String in
      try ZoridCoreHaptics.shared.status()
    }.runOnQueue(.main)
    AsyncFunction("coreHapticsCreate") { (patternJSON: String) -> String in
      try ZoridCoreHaptics.shared.create(patternJSON: patternJSON)
    }.runOnQueue(.main)
    AsyncFunction("coreHapticsCommand") { (playerId: String, commandJSON: String) in
      try ZoridCoreHaptics.shared.command(playerID: playerId, commandJSON: commandJSON)
    }.runOnQueue(.main)
    AsyncFunction("coreHapticsStart") {
      try ZoridCoreHaptics.shared.start()
    }.runOnQueue(.main)
    AsyncFunction("coreHapticsStop") {
      ZoridCoreHaptics.shared.stop()
    }.runOnQueue(.main)
    AsyncFunction("coreHapticsReset") {
      ZoridCoreHaptics.shared.reset()
    }.runOnQueue(.main)
  }

  @objc private func routeQueueChanged() {
    sendEvent("onRoute", [:])
  }
}
