import Foundation
import LocalAuthentication
import CoreFoundation

// App-process authentication only. Keychain access-control enforcement remains
// the responsibility of SecureStore/SecAccessControl, not this Boolean result.
final class ZoridDeviceAuthentication {
  static let shared = ZoridDeviceAuthentication()
  private var activeContext: LAContext?
  private init() {}

  func cancel() {
    activeContext?.invalidate()
    activeContext = nil
  }

  func call(_ operation: String, json: String, completion: @escaping (Result<String, Error>) -> Void) {
    do {
      switch operation {
      case "cancel":
        _ = try ZoridDeviceJSON.object(json, keys: [])
        cancel()
        completion(.success(try ZoridDeviceJSON.encode(["cancelled": true])))
      case "status":
        _ = try ZoridDeviceJSON.object(json, keys: [])
        let context = LAContext()
        var biometricError: NSError?
        let biometric = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &biometricError)
        var ownerError: NSError?
        let owner = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &ownerError)
        let biometry: String
        switch context.biometryType.rawValue {
        case 0: biometry = "none"
        case 1: biometry = "touchID"
        case 2: biometry = "faceID"
        case 3: biometry = "opticID"
        default: biometry = "unknown"
        }
        completion(.success(try ZoridDeviceJSON.encode([
          "available": true, "biometry": biometry,
          "biometric": ["available": biometric, "reason": Self.reason(biometricError) as Any],
          "deviceOwner": ["available": owner, "reason": Self.reason(ownerError) as Any],
        ])))
      case "authenticate":
        let value = try ZoridDeviceJSON.object(json, keys: ["policy", "reason", "cancelTitle", "fallbackTitle", "reuseDuration"])
        guard activeContext == nil else { throw ZoridDeviceError.failure("An authentication request is already active.") }
        let policy: LAPolicy
        switch value["policy"] as? String {
        case "biometric": policy = .deviceOwnerAuthenticationWithBiometrics
        case "deviceOwner": policy = .deviceOwnerAuthentication
        default: throw ZoridDeviceError.invalid("Choose biometric or deviceOwner authentication.")
        }
        guard let reason = value["reason"] as? String, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              reason.utf8.count <= 4096 else { throw ZoridDeviceError.invalid("Authentication needs a nonempty reason of at most 4096 UTF-8 bytes.") }
        let context = LAContext()
        if let cancel = value["cancelTitle"] { context.localizedCancelTitle = try Self.title(cancel) }
        if let fallback = value["fallbackTitle"] { context.localizedFallbackTitle = try Self.title(fallback) }
        if let raw = value["reuseDuration"] {
          guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                number.doubleValue.isFinite, number.doubleValue >= 0,
                number.doubleValue <= LATouchIDAuthenticationMaximumAllowableReuseDuration else {
            throw ZoridDeviceError.invalid("Authentication reuse duration exceeds Apple's supported range.")
          }
          context.touchIDAuthenticationAllowableReuseDuration = number.doubleValue
        }
        var error: NSError?
        guard context.canEvaluatePolicy(policy, error: &error) else {
          completion(.success(try ZoridDeviceJSON.encode(["success": false, "reason": Self.reason(error)])))
          return
        }
        activeContext = context
        context.evaluatePolicy(policy, localizedReason: reason) { [weak self] success, error in
          DispatchQueue.main.async {
            if self?.activeContext === context { self?.activeContext = nil }
            context.invalidate()
            do {
              completion(.success(try ZoridDeviceJSON.encode(["success": success,
                "reason": success ? NSNull() : Self.reason(error)])))
            } catch { completion(.failure(error)) }
          }
        }
      default: throw ZoridDeviceError.unsupported("Unknown authentication operation.")
      }
    } catch { completion(.failure(error)) }
  }

  private static func title(_ value: Any) throws -> String {
    guard let value = value as? String, value.utf8.count <= 4096 else {
      throw ZoridDeviceError.invalid("Authentication prompt titles must be strings of at most 4096 UTF-8 bytes.")
    }
    return value
  }

  private static func reason(_ error: Error?) -> Any {
    guard let error else { return NSNull() }
    let value = error as NSError
    guard value.domain == LAError.errorDomain, let code = LAError.Code(rawValue: value.code) else { return "unknown" }
    switch code {
    case .authenticationFailed: return "authenticationFailed"
    case .userCancel: return "userCancel"
    case .userFallback: return "userFallback"
    case .systemCancel: return "systemCancel"
    case .passcodeNotSet: return "passcodeNotSet"
    case .biometryNotAvailable: return "biometryNotAvailable"
    case .biometryNotEnrolled: return "biometryNotEnrolled"
    case .biometryLockout: return "biometryLockout"
    case .appCancel: return "appCancel"
    case .invalidContext: return "invalidContext"
    case .notInteractive: return "notInteractive"
    default: return "unknown"
    }
  }
}
