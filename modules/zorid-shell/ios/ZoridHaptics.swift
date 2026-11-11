import UIKit
import CoreHaptics
import CoreFoundation

enum ZoridHapticsError: LocalizedError {
  case invalidStyle, invalidIntensity, invalidType, invalidPoint, locationUnavailable, noView, invalidPreparation
  var errorDescription: String? {
    switch self {
    case .invalidStyle: return "Use a light, medium, heavy, soft or rigid impact style."
    case .invalidIntensity: return "Haptic intensity must be a finite number from 0 to 1."
    case .invalidType: return "Use success, warning or error notification feedback."
    case .invalidPoint: return "Haptic location must contain finite x/y coordinates in the current view's coordinate space."
    case .locationUnavailable: return "Haptic locations require iOS 17.5 or later."
    case .noView: return "A foreground view is required for location-based haptics."
    case .invalidPreparation: return "Prepare impact (with an optional style), selection or notification feedback."
    }
  }
}

// App-only UIKit service. Expo exports invoke every operation on the main queue.
// A generator is reused while its foreground view is current, then released.
final class ZoridHaptics {
  static let shared = ZoridHaptics()
  private weak var view: UIView?
  private var impacts: [String: UIImpactFeedbackGenerator] = [:]
  private var selectionGenerator: UISelectionFeedbackGenerator?
  private var notificationGenerator: UINotificationFeedbackGenerator?
  private init() {}

  func status() throws -> String {
    let result: [String: Any] = ["available": true, "location": supportsLocation,
      "supportsHaptics": CHHapticEngine.capabilitiesForHardware().supportsHaptics]
    return String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self)
  }

  func impact(style: String, intensity: Double?, pointJSON: String?) throws {
    let nativeStyle = try impactStyle(style)
    if let intensity, !intensity.isFinite || !(0...1).contains(intensity) { throw ZoridHapticsError.invalidIntensity }
    let point = try location(pointJSON)
    let generator = impactGenerator(style, nativeStyle: nativeStyle)
    if let point {
      if #available(iOS 17.5, *) {
        if let intensity { generator.impactOccurred(intensity: CGFloat(intensity), at: point) }
        else { generator.impactOccurred(at: point) }
      }
    } else if let intensity { generator.impactOccurred(intensity: CGFloat(intensity)) }
    else { generator.impactOccurred() }
  }

  func selection(pointJSON: String?) throws {
    let point = try location(pointJSON)
    let generator = selectionFeedback()
    if let point {
      if #available(iOS 17.5, *) { generator.selectionChanged(at: point) }
    } else { generator.selectionChanged() }
  }

  func notification(type: String, pointJSON: String?) throws {
    let nativeType: UINotificationFeedbackGenerator.FeedbackType
    switch type {
    case "success": nativeType = .success
    case "warning": nativeType = .warning
    case "error": nativeType = .error
    default: throw ZoridHapticsError.invalidType
    }
    let point = try location(pointJSON)
    let generator = notificationFeedback()
    if let point {
      if #available(iOS 17.5, *) { generator.notificationOccurred(nativeType, at: point) }
    } else { generator.notificationOccurred(nativeType) }
  }

  func prepare(kind: String, style: String?) throws {
    refreshView()
    switch kind {
    case "impact":
      let name = style ?? "medium"
      impactGenerator(name, nativeStyle: try impactStyle(name)).prepare()
    case "selection":
      guard style == nil else { throw ZoridHapticsError.invalidPreparation }
      selectionFeedback().prepare()
    case "notification":
      guard style == nil else { throw ZoridHapticsError.invalidPreparation }
      notificationFeedback().prepare()
    default: throw ZoridHapticsError.invalidPreparation
    }
  }

  func reset() {
    if #available(iOS 17.5, *), let view {
      for generator in impacts.values { view.removeInteraction(generator) }
      if let selectionGenerator { view.removeInteraction(selectionGenerator) }
      if let notificationGenerator { view.removeInteraction(notificationGenerator) }
    }
    impacts.removeAll()
    selectionGenerator = nil
    notificationGenerator = nil
    view = nil
  }

  private var supportsLocation: Bool {
    if #available(iOS 17.5, *) { return true }
    return false
  }

  private func impactStyle(_ style: String) throws -> UIImpactFeedbackGenerator.FeedbackStyle {
    switch style {
    case "light": return .light
    case "medium": return .medium
    case "heavy": return .heavy
    case "soft": return .soft
    case "rigid": return .rigid
    default: throw ZoridHapticsError.invalidStyle
    }
  }

  private func location(_ json: String?) throws -> CGPoint? {
    refreshView()
    guard let json else { return nil }
    guard supportsLocation else { throw ZoridHapticsError.locationUnavailable }
    guard view != nil else { throw ZoridHapticsError.noView }
    guard json.utf8.count <= 512,
          let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
          let values = object as? [String: Any], Set(values.keys) == Set(["x", "y"]),
          let x = values["x"] as? NSNumber, let y = values["y"] as? NSNumber,
          CFGetTypeID(x) != CFBooleanGetTypeID(), CFGetTypeID(y) != CFBooleanGetTypeID(),
          x.doubleValue.isFinite, y.doubleValue.isFinite else {
      throw ZoridHapticsError.invalidPoint
    }
    return CGPoint(x: x.doubleValue, y: y.doubleValue)
  }

  private func refreshView() {
    let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }?.keyWindow
    var controller = window?.rootViewController
    while let presented = controller?.presentedViewController, !presented.isBeingDismissed { controller = presented }
    let current = controller?.viewIfLoaded
    if view !== current {
      reset()
      view = current
    }
  }

  private func impactGenerator(_ name: String, nativeStyle: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator {
    if let existing = impacts[name] { return existing }
    let generator: UIImpactFeedbackGenerator
    if #available(iOS 17.5, *), let view { generator = UIImpactFeedbackGenerator(style: nativeStyle, view: view) }
    else { generator = UIImpactFeedbackGenerator(style: nativeStyle) }
    impacts[name] = generator
    return generator
  }

  private func selectionFeedback() -> UISelectionFeedbackGenerator {
    if let selectionGenerator { return selectionGenerator }
    let generator: UISelectionFeedbackGenerator
    if #available(iOS 17.5, *), let view { generator = UISelectionFeedbackGenerator(view: view) }
    else { generator = UISelectionFeedbackGenerator() }
    selectionGenerator = generator
    return generator
  }

  private func notificationFeedback() -> UINotificationFeedbackGenerator {
    if let notificationGenerator { return notificationGenerator }
    let generator: UINotificationFeedbackGenerator
    if #available(iOS 17.5, *), let view { generator = UINotificationFeedbackGenerator(view: view) }
    else { generator = UINotificationFeedbackGenerator() }
    notificationGenerator = generator
    return generator
  }
}
