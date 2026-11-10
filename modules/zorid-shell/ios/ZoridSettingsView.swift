import SwiftUI
import AVFoundation

struct ZoridSettingsView: View {
  @ObservedObject var model: ZoridHostModel
  let close: () -> Void
  @State private var pairingLink = ""
  @State private var scanning = false
  @State private var confirmingDisconnect = false

  var body: some View {
    NavigationStack {
      Form {
        if !model.hasApp {
          Section {
            Text("Connect your host to load your app. Once downloaded, it opens directly and works offline.")
          }
        }
        Section("Host") {
          if let hostName = model.hostName {
            LabeledContent("Paired host", value: hostName)
          } else {
            Text("No host paired")
          }
          if let origin = model.origin {
            Text(origin).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
          } else {
            Text("This build has no configured update host. Install a build configured for your host.")
              .foregroundStyle(.secondary)
          }
          if model.busy {
            HStack(spacing: 12) { ProgressView(); Text(model.status) }
          } else {
            Text(model.status).foregroundStyle(.secondary)
          }
          if let error = model.errorMessage {
            Text(error).foregroundStyle(.red).accessibilityLabel("Error. \(error)")
          }
        }
        if model.origin != nil {
          Section {
            Button(action: requestCamera) { Label("Scan pairing QR code", systemImage: "qrcode.viewfinder") }
            TextField("Paste Zorid pairing link", text: $pairingLink, axis: .vertical)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)
              .privacySensitive()
              .accessibilityLabel("Pairing link")
            Button("Pair host") {
              let link = pairingLink
              pairingLink = ""
              model.pair(link)
            }.disabled(pairingLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          } header: {
            Text(model.hostName == nil ? "Connect" : "Pair again")
          } footer: {
            Text("Generate a pairing code on your host. Pairing lets this host deliver code that runs inside Zorid.")
          }.disabled(model.busy)
        }
        if model.hostName != nil {
          Section("App") {
            Button {
              model.checkAndDownload(automaticallyReload: !model.hasApp)
            } label: { Label("Check and download update", systemImage: "arrow.down.circle") }
              .disabled(model.busy)
            if model.downloaded {
              Button { model.reload() } label: { Label("Reload app", systemImage: "arrow.clockwise") }
                .disabled(model.busy)
            }
          }
          Section {
            Button("Disconnect host", role: .destructive) { confirmingDisconnect = true }
              .disabled(model.busy)
          } footer: {
            Text("Disconnecting removes this phone’s saved connection. Your downloaded app and personal data stay on this device.")
          }
        }
        Section {
          Text("To open these settings, hold three fingers on the screen for one second, or touch and hold Zorid’s Home Screen icon and choose Zorid Settings.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Host Settings")
      .toolbar {
        if model.hasApp {
          ToolbarItem(placement: .confirmationAction) { Button("Done", action: close) }
        }
      }
      .confirmationDialog("Disconnect this host?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
        Button("Disconnect host", role: .destructive) { model.disconnect() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("Your app and personal data will remain on this device.")
      }
      .sheet(isPresented: $scanning) {
        NavigationStack {
          ZoridQRScanner(onCode: { code in
            scanning = false
            model.pair(code)
          }, onFailure: {
            scanning = false
            model.reportCameraFailure("Camera could not start. Paste your pairing link instead.")
          })
          .ignoresSafeArea(edges: .bottom)
          .navigationTitle("Scan pairing QR")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
        }
      }
    }
    .tint(Color(red: 0.03, green: 0.43, blue: 0.40))
  }

  private func requestCamera() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: scanning = true
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          if granted { scanning = true }
          else { model.reportCameraFailure("Camera access is off. Paste your pairing link or enable Camera in system Settings.") }
        }
      }
    default:
      model.reportCameraFailure("Camera access is off. Paste your pairing link or enable Camera in system Settings.")
    }
  }
}
