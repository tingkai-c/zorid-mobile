import ExpoModulesCore

public final class ZoridShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ZoridShell")

    AsyncFunction("openSettings") { () -> Bool in
      ZoridShellCoordinator.shared.openSettings()
    }.runOnQueue(.main)
  }
}
