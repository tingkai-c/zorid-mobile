import Foundation
import Combine
import EXUpdates
import UIKit

// This model is used only on the main queue. Native networking/update callbacks
// return there before publishing UI state; no React runtime is needed.
final class ZoridHostModel: ObservableObject {
  @Published private(set) var hostName: String?
  @Published private(set) var busy = false
  @Published private(set) var downloaded = false
  @Published private(set) var hasApp = false
  @Published private(set) var updatesEnabled = false
  @Published private(set) var status = "Connect a host to load your app."
  @Published private(set) var errorMessage: String?
  let origin = ZoridPairing.installedOrigin()

  private var credential: ZoridPairedHost?
  private var pairingSession: URLSession?
  private let pairingFeedback = UINotificationFeedbackGenerator()
  var onRelaunch: (() -> Void)?

  func refreshLaunchState() {
    #if DEBUG
    // A development client renders its Metro app without a downloaded release.
    updatesEnabled = false
    hasApp = true
    return
    #else
    guard AppController.isInitialized(), AppController.sharedInstance.isStarted,
      AppController.sharedInstance.launchAssetUrl() != nil || !AppController.sharedInstance.isActiveController else { return }
    let constants = AppController.sharedInstance.getConstantsForModule().toModuleConstantsMap()
    updatesEnabled = constants["isEnabled"] as? Bool ?? false
    hasApp = updatesEnabled && !(constants["isEmbeddedLaunch"] as? Bool ?? true)
    #endif
  }

  func restoreCredential() {
    guard !busy, let origin else { return }
    do {
      credential = try ZoridCredentialStore.load(origin: origin)
      hostName = credential?.hostName
      try applyHeaders()
      errorMessage = nil
      status = credential == nil ? "Connect a host to load your app." : (downloaded ? "Update downloaded. Reload to open it." : (hasApp ? "Your downloaded app is available offline." : "Ready to download your app."))
    } catch {
      credential = nil
      hostName = nil
      errorMessage = "The saved connection could not be opened. Unlock your phone and try again, or pair a host."
    }
  }

  private func applyHeaders() throws {
    guard updatesEnabled, AppController.isInitialized() else { return }
    try AppController.sharedInstance.setUpdateRequestHeadersOverride(
      credential.map { ["Authorization": "Bearer \($0.token)"] }
    )
  }

  func pair(_ value: String) {
    guard !busy, let origin else { return }
    let token: String
    do { token = try ZoridPairing.offer(value, trustedOrigin: origin) }
    catch let failure as ZoridPairingFailure { failPairing(failure.message); return }
    catch { failPairing(ZoridPairingFailure.invalidLink.message); return }
    guard let endpoint = URL(string: "\(origin)/pair"),
      let body = try? JSONSerialization.data(withJSONObject: ["token": token, "deviceName": "Zorid iPhone"])
    else { failPairing(ZoridPairingFailure.invalidLink.message); return }

    busy = true
    errorMessage = nil
    status = "Pairing with your host…"
    pairingFeedback.prepare()
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 15
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 15
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    let session = URLSession(configuration: configuration, delegate: ZoridNoRedirects(), delegateQueue: nil)
    pairingSession = session
    session.dataTask(with: request) { [weak self] data, response, error in
      DispatchQueue.main.async {
        guard let self else { return }
        self.pairingSession?.finishTasksAndInvalidate()
        self.pairingSession = nil
        self.busy = false
        guard error == nil, let response = response as? HTTPURLResponse else {
          self.failPairing("Could not reach your host. Check Tailscale and try a fresh pairing code.")
          return
        }
        guard response.statusCode == 200 else {
          if response.statusCode == 401 || response.statusCode == 410 {
            self.failPairing("This pairing code has expired or was already used. Generate a fresh code on your host.")
          } else {
            self.failPairing("The host rejected pairing. Generate a fresh code and try again.")
          }
          return
        }
        guard let data, data.count <= 16_384,
          let decoded = try? JSONDecoder().decode(ZoridPairedHost.self, from: data),
          let paired = try? ZoridPairing.validate(decoded, origin: origin)
        else { self.failPairing(ZoridPairingFailure.invalidResponse.message); return }
        do { try ZoridCredentialStore.save(paired) }
        catch { self.failPairing(ZoridPairingFailure.storage.message); return }
        self.credential = paired
        self.hostName = paired.hostName
        do { try self.applyHeaders() }
        catch { self.failPairing("Host paired, but the updater could not use this connection. Try checking again."); return }
        self.status = "Host paired."
        self.pairingFeedback.notificationOccurred(.success)
        self.checkAndDownload(automaticallyReload: !self.hasApp)
      }
    }.resume()
  }

  func checkAndDownload(automaticallyReload: Bool = false) {
    guard !busy else { return }
    guard credential != nil else { fail("Pair a host before checking for an app update."); return }
    guard updatesEnabled, AppController.isInitialized() else {
      fail("App updates are available in an installed release build.")
      return
    }
    do { try applyHeaders() }
    catch { fail("The updater could not use your saved connection. Pair your host again."); return }
    busy = true
    errorMessage = nil
    status = "Checking your host…"
    AppController.sharedInstance.checkForUpdate(success: { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        switch result {
        case .noUpdateAvailable:
          self.busy = false
          self.status = self.hasApp ? "Your app is up to date." : "No app release is available. Deploy an app from your host, then try again."
        case .updateAvailable, .rollBackToEmbedded:
          self.fetch(automaticallyReload: automaticallyReload)
        case .error:
          self.failUpdate()
        }
      }
    }, error: { [weak self] _ in
      DispatchQueue.main.async { self?.failUpdate() }
    })
  }

  private func fetch(automaticallyReload: Bool) {
    status = "Downloading app update…"
    AppController.sharedInstance.fetchUpdate(success: { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        self.busy = false
        switch result {
        case .success:
          self.downloaded = true
          self.status = "Update downloaded. Reload to open it."
          if automaticallyReload { self.reload() }
        case .rollBackToEmbedded:
          // A host rollback must not trap first launch in a relaunch loop.
          self.downloaded = self.hasApp
          self.status = self.hasApp ? "The host requested a reset. Reload to return to connection settings." : "The host has no active app. Deploy an app, then try again."
        case .failure, .error:
          self.failUpdate()
        }
      }
    }, error: { [weak self] _ in
      DispatchQueue.main.async { self?.failUpdate() }
    })
  }

  func reload() {
    guard !busy, downloaded, updatesEnabled, AppController.isInitialized() else { return }
    busy = true
    errorMessage = nil
    status = "Opening your app…"
    AppController.sharedInstance.requestRelaunch(success: { [weak self] in
      DispatchQueue.main.async {
        self?.busy = false
        self?.downloaded = false
        self?.onRelaunch?()
      }
    }, error: { [weak self] _ in
      DispatchQueue.main.async { self?.fail("The downloaded app could not open. Try Reload again.") }
    })
  }

  func disconnect() {
    guard !busy else { return }
    do { try ZoridCredentialStore.clear() }
    catch { fail("The saved connection could not be removed. Unlock your phone and try again."); return }
    credential = nil
    hostName = nil
    downloaded = false
    do { try applyHeaders() }
    catch { fail("The connection was removed. Restart Zorid to finish resetting the updater."); return }
    errorMessage = nil
    status = "Host disconnected. Your saved app and personal data remain on this device."
  }

  func reportCameraFailure(_ message: String) { errorMessage = message }

  private func failUpdate() {
    fail("The update could not be checked or downloaded. Check Tailscale and your host, then try again. Your saved app remains available.")
  }

  private func failPairing(_ message: String) {
    fail(message)
    pairingFeedback.notificationOccurred(.error)
  }

  private func fail(_ message: String) {
    busy = false
    errorMessage = message
    status = hostName == nil ? "No host paired." : "Host paired."
  }
}
