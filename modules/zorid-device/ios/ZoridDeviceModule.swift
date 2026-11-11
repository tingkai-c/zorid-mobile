import ExpoModulesCore
import Foundation

public final class ZoridDeviceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ZoridDevice")

    OnDestroy {
      DispatchQueue.main.async {
        ZoridDeviceAuthentication.shared.cancel()
        ZoridDeviceMedia.shared.cancel()
        ZoridDeviceCalendar.shared.cancel()
      }
    }

    AsyncFunction("capabilities") { () -> String in
      try ZoridDeviceJSON.encode([
        "available": true, "version": 1, "platform": "ios",
        "features": ["authentication": true, "notifications": true, "clipboard": true,
          "photosPicker": true, "photosAdd": true, "calendar": true, "reminders": true],
        "requestBytes": ZoridDeviceJSON.byteLimit, "responseBytes": ZoridDeviceJSON.byteLimit,
      ] as [String: Any])
    }.runOnQueue(.main)

    AsyncFunction("call") { (domain: String, operation: String, json: String, promise: Promise) in
      let completion: (Result<String, Error>) -> Void = { result in
        switch result {
        case .success(let value): promise.resolve(value)
        case .failure(let error): promise.reject("ERR_ZORID_DEVICE", error.localizedDescription)
        }
      }
      switch domain {
      case "authentication": ZoridDeviceAuthentication.shared.call(operation, json: json, completion: completion)
      case "notifications": ZoridDeviceNotifications.shared.call(operation, json: json, completion: completion)
      case "media": ZoridDeviceMedia.shared.call(operation, json: json, completion: completion)
      case "calendar": ZoridDeviceCalendar.shared.call(operation, json: json, completion: completion)
      default: completion(.failure(ZoridDeviceError.unsupported("Unknown device capability.")))
      }
    }.runOnQueue(.main)
  }
}
