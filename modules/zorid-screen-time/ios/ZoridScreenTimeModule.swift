import ExpoModulesCore
import Foundation
import FamilyControls
import SwiftUI
import UIKit

private struct ZoridScreenTimePicker: View {
  let mode: String
  @State var selection: FamilyActivitySelection
  let finish: (FamilyActivitySelection?) -> Void
  @State private var saving = false

  var body: some View {
    NavigationStack {
      FamilyActivityPicker(selection: $selection)
        .navigationTitle(mode == "allowlist" ? "Allowed apps" : "Blocked apps")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
          Text(mode == "allowlist"
            ? "Choose up to 50 individual apps to allow. Zorid stays available. Categories and websites aren't supported here."
            : "Choose apps or categories to block while focusing. Websites aren't supported here.")
            .font(.footnote).foregroundStyle(.secondary).padding()
            .frame(maxWidth: .infinity).background(.bar)
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { guard !saving else { return }; saving = true; finish(nil) }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") { guard !saving else { return }; saving = true; finish(selection) }
              .disabled(!validSelection)
          }
        }
    }
  }
  private var validSelection: Bool {
    selection.applicationTokens.count <= 50 && selection.webDomainTokens.isEmpty
      && (mode != "blocklist" || !selection.applicationTokens.isEmpty || !selection.categoryTokens.isEmpty)
      && (mode != "allowlist" || selection.categoryTokens.isEmpty)
  }
}

public final class ZoridScreenTimeModule: Module {
  private var picker: UIViewController?

  public func definition() -> ModuleDefinition {
    Name("ZoridScreenTime")
    AsyncFunction("status") { (appId: String) -> String in
      try ZoridScreenTimeController.shared.status(appId: appId)
    }
    AsyncFunction("requestAuthorization") { () async throws in
      try ZoridScreenTimeController.shared.prepareAuthorization()
      try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
    }
    AsyncFunction("editPolicy") { (appId: String, policyId: String, mode: String, promise: Promise) in
      self.presentPicker(appId: appId, policyId: policyId, mode: mode, promise: promise)
    }.runOnQueue(.main)
    AsyncFunction("deletePolicy") { (appId: String, policyId: String) in
      try ZoridScreenTimeController.shared.deletePolicy(appId: appId, policyId: policyId)
    }
    AsyncFunction("clear") { (appId: String) in
      try ZoridScreenTimeController.shared.clear(appId: appId)
    }
    // Direct deployed interfaces can call the same validated operation as native
    // action handlers; no application identities/tokens cross this JSON boundary.
    AsyncFunction("apply") { (appId: String, commandJSON: String) in
      guard commandJSON.utf8.count <= 4096,
            let data = commandJSON.data(using: .utf8),
            let command = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw ZoridScreenTimeError.invalidCommand
      }
      try ZoridScreenTimeController.shared.apply(appId: appId, command: command)
    }
  }

  private func presentPicker(appId: String, policyId: String, mode: String, promise: Promise) {
    do {
      try ZoridScreenTimePlan.identifier(appId)
      try ZoridScreenTimePlan.identifier(policyId)
      guard mode == "allowlist" || mode == "blocklist" else { throw ZoridScreenTimeError.invalidMode }
      guard picker == nil else { throw ZoridScreenTimeError.busy }
      guard AuthorizationCenter.shared.authorizationStatus == .approved else { throw ZoridScreenTimeError.unavailableAuthorization }
      let controller = ZoridScreenTimeController.shared
      let statusData = Data(try controller.status(appId: appId).utf8)
      let status = try JSONSerialization.jsonObject(with: statusData) as? [String: Any]
      if let active = status?["active"] as? [String: Any], active["policyId"] as? String == policyId {
        throw ZoridScreenTimeError.policyActive
      }
      guard let presenter = appContext?.utilities?.currentViewController(), presenter.viewIfLoaded?.window != nil else {
        promise.reject("E_SCREEN_TIME_PRESENTATION", "Open Zorid to choose apps.")
        return
      }
      let selection = try controller.selection(appId: appId, policyId: policyId)
      let view = ZoridScreenTimePicker(mode: mode, selection: selection) { [weak self] saved in
        guard let self else { return }
        let presented = self.picker
        self.picker = nil
        do {
          if let saved { try controller.savePolicy(appId: appId, policyId: policyId, mode: mode, selection: saved) }
          let result = try controller.status(appId: appId)
          presented?.dismiss(animated: true) { promise.resolve(result) }
        } catch {
          presented?.dismiss(animated: true) { promise.reject("E_SCREEN_TIME_POLICY", error.localizedDescription) }
        }
      }
      let hosting = UIHostingController(rootView: view)
      hosting.isModalInPresentation = true
      picker = hosting
      presenter.present(hosting, animated: true)
    } catch { promise.reject("E_SCREEN_TIME_POLICY", error.localizedDescription) }
  }
}
