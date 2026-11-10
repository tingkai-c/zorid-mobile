import UIKit
import SwiftUI
import EXUpdates

/// Installed-binary recovery surface. Scene hooks attach it to the UIWindow,
/// so a downloaded app cannot accidentally remove the settings gesture.
public final class ZoridShellCoordinator: NSObject, UIGestureRecognizerDelegate {
  public static let shared = ZoridShellCoordinator()
  public static let settingsShortcutType = "app.zorid.mobile.host-settings"

  private weak var window: UIWindow?
  private var gesture: UILongPressGestureRecognizer?
  private var panel: UIViewController?
  private let model = ZoridHostModel()
  private var readinessTimer: Timer?
  private var startupResolved = false
  private var attemptedInitialDownload = false
  private var pendingOpen = false

  private override init() {
    super.init()
    model.onRelaunch = { [weak self] in self?.didRelaunch() }
  }

  public func attach(to window: UIWindow?, shortcut: UIApplicationShortcutItem? = nil) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.attach(to: window, shortcut: shortcut) }
      return
    }
    if let window, self.window !== window {
      if let gesture { self.window?.removeGestureRecognizer(gesture) }
      self.window = window
      let hold = UILongPressGestureRecognizer(target: self, action: #selector(didHold(_:)))
      hold.minimumPressDuration = 1
      hold.numberOfTouchesRequired = 3
      hold.allowableMovement = 18
      hold.cancelsTouchesInView = false
      hold.delaysTouchesBegan = false
      hold.delegate = self
      window.addGestureRecognizer(hold)
      gesture = hold
    }
    if let shortcut { _ = handleShortcut(shortcut) }
    inspectStartup()
    if !startupResolved, readinessTimer == nil {
      let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.inspectStartup() }
      readinessTimer = timer
      RunLoop.main.add(timer, forMode: .common)
    }
    presentIfNeeded()
  }

  public func openSettings() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.openSettings() }
      return
    }
    pendingOpen = true
    inspectStartup()
    model.refreshLaunchState()
    model.restoreCredential()
    presentIfNeeded()
  }

  @discardableResult
  public func handleShortcut(_ item: UIApplicationShortcutItem) -> Bool {
    guard item.type == Self.settingsShortcutType else { return false }
    openSettings()
    return true
  }

  @objc private func didHold(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    openSettings()
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                                shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    true
  }

  private func inspectStartup() {
    #if DEBUG
    // Metro remains responsible for development UI; recovery is still available
    // explicitly through the gesture, shortcut, or module method.
    guard !startupResolved else { return }
    startupResolved = true
    model.refreshLaunchState()
    model.restoreCredential()
    presentIfNeeded()
    return
    #else
    guard !startupResolved, AppController.isInitialized(),
      AppController.sharedInstance.isStarted,
      AppController.sharedInstance.launchAssetUrl() != nil || !AppController.sharedInstance.isActiveController else { return }
    startupResolved = true
    readinessTimer?.invalidate()
    readinessTimer = nil
    model.refreshLaunchState()
    model.restoreCredential()
    if !model.hasApp {
      pendingOpen = true
      presentIfNeeded()
      if model.hostName != nil, !attemptedInitialDownload {
        attemptedInitialDownload = true
        model.checkAndDownload(automaticallyReload: true)
      }
    }
    // A cold Home Screen shortcut may have queued this while updates was
    // starting. Present it for a cached app too, once launch state is known.
    presentIfNeeded()
    #endif
  }

  private func presentIfNeeded() {
    guard startupResolved, pendingOpen, panel == nil, let window,
      let root = window.rootViewController else { return }
    // Wait for the native root to join its window, independently of React mounting.
    guard root.viewIfLoaded?.window != nil else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.presentIfNeeded() }
      return
    }
    var presenter = root
    while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
      presenter = presented
    }
    guard !presenter.isBeingPresented, !presenter.isBeingDismissed else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.presentIfNeeded() }
      return
    }
    let controller = UIHostingController(rootView: ZoridSettingsView(model: model, close: { [weak self] in
      self?.dismissSettings()
    }))
    controller.modalPresentationStyle = model.hasApp ? .pageSheet : .fullScreen
    controller.isModalInPresentation = !model.hasApp
    controller.presentationController?.delegate = self
    panel = controller
    pendingOpen = false
    presenter.present(controller, animated: model.hasApp) { [weak self, weak controller] in
      controller?.presentationController?.delegate = self
    }
  }

  private func dismissSettings() {
    guard model.hasApp else { return }
    pendingOpen = false
    panel?.dismiss(animated: true)
    panel = nil
  }

  private func didRelaunch() {
    model.refreshLaunchState()
    let previous = panel
    panel = nil
    pendingOpen = !model.hasApp
    if let previous {
      previous.dismiss(animated: false) { [weak self] in self?.presentIfNeeded() }
    } else {
      presentIfNeeded()
    }
  }
}

extension ZoridShellCoordinator: UIAdaptivePresentationControllerDelegate {
  public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    if panel === presentationController.presentedViewController { panel = nil }
  }
}
