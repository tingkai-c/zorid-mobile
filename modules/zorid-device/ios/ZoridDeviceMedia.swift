import Foundation
import UIKit
import Photos
import PhotosUI
import UniformTypeIdentifiers
import CoreFoundation

// Application-process capabilities. The Expo module invokes call on the main queue.
// PHPicker grants access only to the selected representations, not the whole library.
final class ZoridDeviceMedia: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  static let shared = ZoridDeviceMedia()
  private let maximumFileBytes: Int64 = 256 * 1024 * 1024
  private let maximumBatchBytes: Int64 = 512 * 1024 * 1024
  private var pickSession: PickSession?

  private final class PickSession {
    let picker: PHPickerViewController
    let directory: URL
    let completion: (Result<String, Error>) -> Void
    var selectionHandled = false
    var totalBytes: Int64 = 0
    var assets: [[String: Any]] = []
    var progress: Progress?
    private let cancellationLock = NSLock()
    private var cancelled = false
    init(picker: PHPickerViewController, directory: URL, completion: @escaping (Result<String, Error>) -> Void) {
      self.picker = picker
      self.directory = directory
      self.completion = completion
    }
    func invalidate() {
      cancellationLock.lock()
      cancelled = true
      cancellationLock.unlock()
    }
    var isCancelled: Bool {
      cancellationLock.lock()
      defer { cancellationLock.unlock() }
      return cancelled
    }
  }

  private override init() { super.init() }

  // Called on the main queue when the RN module/runtime is destroyed. This
  // cancels only this service's picker/import, never committed Photos writes.
  func cancel() {
    guard let session = pickSession else { return }
    session.invalidate()
    let progress = session.progress
    session.progress = nil
    session.picker.delegate = nil
    session.picker.presentationController?.delegate = nil
    // Invalidate ownership and settle once before cancellation/dismissal can
    // trigger a provider or presentation callback.
    finish(session, result: .success(["cancelled": true, "assets": []]), keepFiles: false)
    progress?.cancel()
    if session.picker.presentingViewController != nil { session.picker.dismiss(animated: false) }
  }

  func call(_ operation: String, json: String, completion: @escaping (Result<String, Error>) -> Void) {
    do {
      switch operation {
      case "clipboardStatus":
        _ = try ZoridDeviceJSON.object(json, keys: [])
        let board = UIPasteboard.general
        completion(.success(try ZoridDeviceJSON.encode([
          "hasStrings": board.hasStrings, "hasURLs": board.hasURLs, "changeCount": board.changeCount,
        ])))
      case "clipboardGet":
        _ = try ZoridDeviceJSON.object(json, keys: [])
        try requireForeground()
        let board = UIPasteboard.general
        let text = board.string
        let url = board.url?.absoluteString
        guard (text?.utf8.count ?? 0) <= 1024 * 1024, (url?.utf8.count ?? 0) <= 1024 * 1024 else {
          throw ZoridDeviceError.invalid("Clipboard text exceeds the 1 MiB bridge limit.")
        }
        completion(.success(try ZoridDeviceJSON.encode([
          "text": text.map { $0 as Any } ?? NSNull(), "url": url.map { $0 as Any } ?? NSNull(),
        ])))
      case "clipboardSet":
        try requireForeground()
        let input = try ZoridDeviceJSON.object(json, keys: ["text", "url", "localOnly", "expiresAt"])
        let text = try string(input["text"], name: "text")
        let rawURL = try string(input["url"], name: "url")
        guard (text != nil) != (rawURL != nil) else {
          throw ZoridDeviceError.invalid("Supply exactly one clipboard text or URL value.")
        }
        var item: [String: Any] = [:]
        if let text {
          guard text.utf8.count <= 1024 * 1024 else { throw ZoridDeviceError.invalid("Clipboard text exceeds 1 MiB.") }
          item[UTType.utf8PlainText.identifier] = text
        } else if let rawURL {
          guard rawURL.utf8.count <= 1024 * 1024, let url = URL(string: rawURL), url.scheme != nil else {
            throw ZoridDeviceError.invalid("Clipboard URL must be absolute and at most 1 MiB.")
          }
          item[UTType.url.identifier] = url
        }
        var options: [UIPasteboard.OptionsKey: Any] = [:]
        if let local = try boolean(input["localOnly"], name: "localOnly") { options[.localOnly] = local }
        if let expires = try number(input["expiresAt"], name: "expiresAt") {
          guard expires > Date().timeIntervalSince1970 * 1000, expires < 253_402_300_800_000 else {
            throw ZoridDeviceError.invalid("Clipboard expiration must be a future epoch-millisecond date before year 10000.")
          }
          options[.expirationDate] = Date(timeIntervalSince1970: expires / 1000)
        }
        UIPasteboard.general.setItems([item], options: options)
        completion(.success(try ZoridDeviceJSON.encode(["saved": true])))
      case "photosStatus":
        _ = try ZoridDeviceJSON.object(json, keys: [])
        completion(.success(try authorizationJSON()))
      case "photosRequestAdd":
        _ = try ZoridDeviceJSON.object(json, keys: [])
        try requireForeground()
        try requirePhotoPurpose()
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { _ in
          DispatchQueue.main.async {
            do { completion(.success(try self.authorizationJSON())) }
            catch { completion(.failure(error)) }
          }
        }
      case "photosPick":
        try pick(json: json, completion: completion)
      case "photosSave":
        try save(json: json, completion: completion)
      default:
        throw ZoridDeviceError.unsupported("Unsupported media operation.")
      }
    } catch { completion(.failure(error)) }
  }

  private func authorizationJSON() throws -> String {
    try ZoridDeviceJSON.encode(["addOnly": authorizationName(PHPhotoLibrary.authorizationStatus(for: .addOnly))])
  }

  private func authorizationName(_ status: PHAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .limited: return "limited"
    @unknown default: return "unknown"
    }
  }

  private func requireForeground() throws {
    guard UIApplication.shared.applicationState == .active else {
      throw ZoridDeviceError.unsupported("This media operation requires the foreground app.")
    }
  }

  private func requirePhotoPurpose() throws {
    guard let purpose = Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryAddUsageDescription") as? String,
          !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw ZoridDeviceError.unsupported("Install a Zorid build with the Photos add-only permission description.")
    }
  }

  private func presenter() throws -> UIViewController {
    try requireForeground()
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }.flatMap(\.windows)
    guard let window = windows.first(where: \.isKeyWindow), var controller = window.rootViewController else {
      throw ZoridDeviceError.unsupported("A foreground window is required to select photos.")
    }
    while let next = controller.presentedViewController {
      guard !next.isBeingDismissed else { throw ZoridDeviceError.failure("Wait for the current screen to finish closing.") }
      controller = next
    }
    guard controller.viewIfLoaded?.window != nil, !controller.isBeingPresented, !controller.isBeingDismissed else {
      throw ZoridDeviceError.failure("Wait for the current screen to finish opening or closing.")
    }
    return controller
  }

  private func pick(json: String, completion: @escaping (Result<String, Error>) -> Void) throws {
    let input = try ZoridDeviceJSON.object(json, keys: ["selectionLimit", "filter", "ordered"])
    guard pickSession == nil else { throw ZoridDeviceError.failure("A photo selection or import is already in progress.") }
    let limit = try number(input["selectionLimit"], name: "selectionLimit") ?? 1
    guard limit.rounded() == limit, (1...20).contains(limit) else {
      throw ZoridDeviceError.invalid("Select between 1 and 20 media items.")
    }
    let filter = try string(input["filter"], name: "filter") ?? "imagesAndVideos"
    let ordered = try boolean(input["ordered"], name: "ordered") ?? true
    var configuration = PHPickerConfiguration()
    switch filter {
    case "images": configuration.filter = .images
    case "videos": configuration.filter = .videos
    case "imagesAndVideos": configuration.filter = .any(of: [.images, .videos])
    default: throw ZoridDeviceError.invalid("Choose images, videos, or imagesAndVideos.")
    }
    configuration.selectionLimit = Int(limit)
    configuration.selection = ordered ? .ordered : .default
    configuration.preferredAssetRepresentationMode = .current
    let controller = try presenter()
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ZoridMedia", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let session = PickSession(picker: picker, directory: directory, completion: completion)
    pickSession = session
    picker.presentationController?.delegate = self
    controller.present(picker, animated: true)
    picker.presentationController?.delegate = self
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    guard let session = pickSession, session.picker === picker, !session.selectionHandled else { return }
    session.selectionHandled = true
    picker.dismiss(animated: true) {
      guard self.pickSession === session else { return }
      if results.isEmpty {
        self.finish(session, result: .success(["cancelled": true, "assets": []]), keepFiles: false)
      } else if results.count > 20 {
        self.finish(session, result: .failure(ZoridDeviceError.invalid("Too many selected media items.")), keepFiles: false)
      } else {
        self.importNext(results, index: 0, session: session)
      }
    }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    guard let session = pickSession, session.picker === presentationController.presentedViewController,
          !session.selectionHandled else { return }
    session.selectionHandled = true
    finish(session, result: .success(["cancelled": true, "assets": []]), keepFiles: false)
  }

  private func importNext(_ results: [PHPickerResult], index: Int, session: PickSession) {
    guard pickSession === session else { return }
    guard index < results.count else {
      finish(session, result: .success(["cancelled": false, "assets": session.assets]), keepFiles: true)
      return
    }
    let provider = results[index].itemProvider
    guard let identifier = provider.registeredTypeIdentifiers.first(where: {
      guard let type = UTType($0) else { return false }
      return type.conforms(to: .image) || type.conforms(to: .movie)
    }), let type = UTType(identifier) else {
      finish(session, result: .failure(ZoridDeviceError.unsupported("The selected item has no supported image or video file representation.")), keepFiles: false)
      return
    }
    let previousBytes = session.totalBytes
    session.progress = provider.loadFileRepresentation(forTypeIdentifier: identifier) { source, error in
      let imported: Result<([String: Any], Int64), Error>
      do {
        guard !session.isCancelled else { throw ZoridDeviceError.failure("Media import was cancelled.") }
        guard error == nil, let source, source.isFileURL else {
          throw ZoridDeviceError.failure("The selected media file could not be loaded. It may need an iCloud download.")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let bytes = (attributes[.size] as? NSNumber)?.int64Value,
              bytes > 0, bytes <= self.maximumFileBytes, previousBytes + bytes <= self.maximumBatchBytes else {
          throw ZoridDeviceError.invalid("Selected media must be regular files up to 256 MiB each and 512 MiB per selection.")
        }
        let proposedExtension = source.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : source.pathExtension
        let fileExtension = proposedExtension.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) }
          && proposedExtension.utf8.count <= 20 ? proposedExtension : (type.preferredFilenameExtension ?? "")
        let name = UUID().uuidString + (fileExtension.isEmpty ? "" : "." + fileExtension)
        let destination = session.directory.appendingPathComponent(name)
        // The provider deletes its temporary file as soon as this callback returns.
        // Copy here, before dispatching any result to the main queue.
        try FileManager.default.copyItem(at: source, to: destination)
        guard !session.isCancelled else { throw ZoridDeviceError.failure("Media import was cancelled.") }
        let copied = try FileManager.default.attributesOfItem(atPath: destination.path)
        guard let copiedBytes = (copied[.size] as? NSNumber)?.int64Value,
              copiedBytes == bytes, copiedBytes <= self.maximumFileBytes,
              previousBytes + copiedBytes <= self.maximumBatchBytes else {
          throw ZoridDeviceError.failure("The selected media file changed during import.")
        }
        imported = .success(([
          "uri": destination.absoluteString, "fileName": name, "typeIdentifier": identifier,
          "mimeType": type.preferredMIMEType.map { $0 as Any } ?? NSNull(), "bytes": copiedBytes,
          "kind": type.conforms(to: .movie) ? "video" : "image",
        ], copiedBytes))
      } catch { imported = .failure(error) }
      // Cancellation may race the provider's file copy. Repeat cleanup after
      // that work finishes so late callbacks cannot leave an orphaned batch.
      if session.isCancelled { try? FileManager.default.removeItem(at: session.directory) }
      DispatchQueue.main.async {
        guard self.pickSession === session else {
          if session.isCancelled { try? FileManager.default.removeItem(at: session.directory) }
          return
        }
        session.progress = nil
        switch imported {
        case .success(let (asset, bytes)):
          session.assets.append(asset)
          session.totalBytes += bytes
          self.importNext(results, index: index + 1, session: session)
        case .failure:
          self.finish(session, result: .failure(ZoridDeviceError.failure("Unable to import the selected media within the file limits.")), keepFiles: false)
        }
      }
    }
  }

  private func finish(_ session: PickSession, result: Result<[String: Any], Error>, keepFiles: Bool) {
    guard pickSession === session else { return }
    pickSession = nil
    if !keepFiles { try? FileManager.default.removeItem(at: session.directory) }
    do { session.completion(.success(try ZoridDeviceJSON.encode(result.get()))) }
    catch { session.completion(.failure(error)) }
  }

  private func save(json: String, completion: @escaping (Result<String, Error>) -> Void) throws {
    try requireForeground()
    try requirePhotoPurpose()
    let input = try ZoridDeviceJSON.object(json, keys: ["uri", "kind"])
    guard let uri = try string(input["uri"], name: "uri"), let kind = try string(input["kind"], name: "kind"),
          ["image", "video"].contains(kind) else {
      throw ZoridDeviceError.invalid("Supply a local file URI and image or video kind.")
    }
    let url = try ZoridDeviceJSON.localFile(uri)
    let saveWithPermission: (PHAuthorizationStatus) -> Void = { status in
      guard status == .authorized || status == .limited else {
        completion(.failure(ZoridDeviceError.failure("Photos add-only access was not granted.")))
        return
      }
      var identifier: String?
      PHPhotoLibrary.shared().performChanges({
        let request = kind == "video"
          ? PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
          : PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url)
        identifier = request?.placeholderForCreatedAsset?.localIdentifier
      }) { success, _ in
        DispatchQueue.main.async {
          do {
            guard success, let identifier else { throw ZoridDeviceError.failure("Photos could not save the supplied media file.") }
            completion(.success(try ZoridDeviceJSON.encode(["saved": true, "localIdentifier": identifier])))
          } catch { completion(.failure(error)) }
        }
      }
    }
    let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    if status == .notDetermined {
      PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
        DispatchQueue.main.async { saveWithPermission(status) }
      }
    } else { saveWithPermission(status) }
  }

  private func string(_ value: Any?, name: String) throws -> String? {
    guard let value else { return nil }
    guard let string = value as? String else { throw ZoridDeviceError.invalid("\(name) must be a string.") }
    return string
  }

  private func number(_ value: Any?, name: String) throws -> Double? {
    guard let value else { return nil }
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else {
      throw ZoridDeviceError.invalid("\(name) must be a finite number.")
    }
    return number.doubleValue
  }

  private func boolean(_ value: Any?, name: String) throws -> Bool? {
    guard let value else { return nil }
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
      throw ZoridDeviceError.invalid("\(name) must be a boolean.")
    }
    return number.boolValue
  }
}
