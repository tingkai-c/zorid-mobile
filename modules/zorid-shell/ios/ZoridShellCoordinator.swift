import UIKit
import SwiftUI
import CoreMotion

/// Installed-binary recovery surface. Scene hooks attach it to the UIWindow,
/// so a downloaded app cannot accidentally remove the settings gesture.
public final class ZoridShellCoordinator: NSObject, UIGestureRecognizerDelegate {
  public static let shared = ZoridShellCoordinator()
  public static let settingsShortcutType = "app.zorid.mobile.host-settings"

  private weak var window: UIWindow?
  private var gesture: UILongPressGestureRecognizer?
  private var panel: UIViewController?
  private weak var panelRoot: UIViewController?
  private var presentationRetryPending = false
  private let model = ZoridHostModel()
  private var readinessTimer: Timer?
  private var startupResolved = false
  private var attemptedInitialDownload = false
  private var pendingOpen = false
  private var pendingOpeningFeedback = false
  private let openingFeedback = UIImpactFeedbackGenerator(style: .heavy)
  private let motion = CMMotionManager()
  private var shakeDetector = ZoridShakeDetector()

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
    ZoridQuickActions.restore()
    if let shortcut { _ = handleShortcut(shortcut) }
    inspectStartup()
    if !startupResolved, readinessTimer == nil {
      let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.inspectStartup() }
      readinessTimer = timer
      RunLoop.main.add(timer, forMode: .common)
    }
    presentIfNeeded()
    if self.window?.windowScene?.activationState == .foregroundActive { startShakeDetection() }
  }

  @discardableResult
  public func openSettings() -> Bool {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in _ = self?.openSettings() }
      return true
    }
    // All explicit entrances share this path. Automatic setup only sets
    // pendingOpen, and repeated requests while visible produce no feedback.
    if panelIsAttached(to: window?.rootViewController) { return true }
    let targetWindow = window ?? UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first { $0.activationState == .foregroundActive }?.keyWindow
    guard let targetWindow else { return false }
    pendingOpeningFeedback = true
    openingFeedback.prepare()
    pendingOpen = true
    if window == nil { attach(to: targetWindow) }
    inspectStartup()
    if !panelIsAttached(to: targetWindow.rootViewController) {
      model.refreshLaunchState()
      model.restoreCredential()
    }
    presentIfNeeded()
    return true
  }

  @discardableResult
  public func handleShortcut(_ item: UIApplicationShortcutItem) -> Bool {
    if item.type == Self.settingsShortcutType {
      openSettings()
      return true
    }
    return ZoridQuickActions.handle(item)
  }

  @discardableResult
  public func handleURL(_ url: URL) -> Bool {
    ZoridRouteQueue.shared.enqueue(url.absoluteString)
  }

  @objc private func didHold(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began else { return }
    openSettings()
  }

  public func stopShakeDetection() {
    motion.stopDeviceMotionUpdates()
    shakeDetector = ZoridShakeDetector()
  }

  private func startShakeDetection() {
    guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
    motion.deviceMotionUpdateInterval = 1.0 / 25.0
    motion.startDeviceMotionUpdates(to: .main) { [weak self] sample, _ in
      guard let self, let sample,
        self.window?.windowScene?.activationState == .foregroundActive,
        !self.panelIsAttached(to: self.window?.rootViewController) else { return }
      let acceleration = sample.userAcceleration
      if self.shakeDetector.record(
        SIMD3(acceleration.x, acceleration.y, acceleration.z),
        at: sample.timestamp
      ) {
        self.openSettings()
      }
    }
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
    guard !startupResolved, model.refreshLaunchState() else { return }
    startupResolved = true
    readinessTimer?.invalidate()
    readinessTimer = nil
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
    guard startupResolved, pendingOpen, let window,
      window.windowScene?.activationState == .foregroundActive,
      let root = window.rootViewController else { return }
    guard !panelIsAttached(to: root) else { return }
    panel = nil
    // Expo Updates sets the launch URL before its main-queue callback replaces
    // the startup view. A modal presented on that view vanishes with it.
    if let view = root.viewIfLoaded {
      let className = NSStringFromClass(type(of: view))
      if className == "EXDeferredRCTRootView" || className == "EXNoopUIView" {
        retryPresentation()
        return
      }
    }
    var presenter = root
    while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
      presenter = presented
    }
    // Full-screen native modals can detach the root view. Use the visible
    // presenter so recovery remains available while one of those is open.
    guard presenter.viewIfLoaded?.window === window,
      !presenter.isBeingPresented, !presenter.isBeingDismissed else {
      retryPresentation()
      return
    }
    let controller = UIHostingController(rootView: ZoridSettingsView(model: model, close: { [weak self] in
      self?.dismissSettings()
    }))
    controller.modalPresentationStyle = .pageSheet
    controller.isModalInPresentation = !model.hasApp
    if let sheet = controller.sheetPresentationController {
      sheet.detents = [.large()]
      sheet.prefersGrabberVisible = model.hasApp
      sheet.prefersEdgeAttachedInCompactHeight = true
      sheet.delegate = self
    }
    panel = controller
    panelRoot = root
    presenter.present(controller, animated: true) { [weak self, weak controller] in
      guard let self, let controller, self.panel === controller else { return }
      guard self.panelIsAttached(to: self.window?.rootViewController) else {
        self.retryPresentation()
        return
      }
      self.pendingOpen = false
      self.playOpeningFeedback()
    }
    // UIKit can decline a presentation during a window transition.
    if panelIsAttached(to: root) {
      playOpeningFeedback()
    } else {
      retryPresentation()
    }
  }

  private func playOpeningFeedback() {
    guard pendingOpeningFeedback else { return }
    pendingOpeningFeedback = false
    openingFeedback.impactOccurred(intensity: 1.0)
  }

  private func panelIsAttached(to root: UIViewController?) -> Bool {
    guard let panel, let root, panelRoot === root else { return false }
    return panel.presentingViewController != nil || panel.isBeingPresented
  }

  private func retryPresentation() {
    guard !presentationRetryPending else { return }
    presentationRetryPending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
      guard let self else { return }
      self.presentationRetryPending = false
      self.presentIfNeeded()
    }
  }

  private func dismissSettings() {
    guard model.hasApp else { return }
    pendingOpen = false
    pendingOpeningFeedback = false
    guard let panel else { return }
    panel.dismiss(animated: true) { [weak self, weak panel] in
      guard let self, self.panel === panel else { return }
      self.panel = nil
    }
  }

  private func didRelaunch() {
    model.refreshLaunchState()
    let previous = panel
    panel = nil
    pendingOpen = !model.hasApp
    pendingOpeningFeedback = false
    if let previous, previous.presentingViewController != nil {
      previous.dismiss(animated: true) { [weak self] in self?.presentIfNeeded() }
    } else {
      presentIfNeeded()
    }
  }
}

extension ZoridShellCoordinator: UISheetPresentationControllerDelegate {
  public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    if panel === presentationController.presentedViewController { panel = nil }
  }
}
