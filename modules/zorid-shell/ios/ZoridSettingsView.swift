import SwiftUI
import AVFoundation

struct ZoridSettingsView: View {
  @ObservedObject var model: ZoridHostModel
  let close: () -> Void
  @State private var pairingLink = ""
  @State private var scanning = false
  @State private var confirmingDisconnect = false
  @FocusState private var pairingLinkFocused: Bool

  var body: some View {
    NavigationStack {
      Form {
        if !model.hasApp { setupSection }
        connectionSection
        if let error = model.errorMessage { errorSection(error) }
        if model.origin != nil { pairingSection }
        if model.hostName != nil {
          updateSection
          disconnectSection
        }
        accessSection
      }
      .formStyle(.grouped)
      .scrollDismissesKeyboard(.interactively)
      .navigationTitle("Zorid Settings")
      .navigationBarTitleDisplayMode(.large)
      .toolbar {
        if model.hasApp {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done", action: close)
              .accessibilityHint("Close settings and return to your app")
          }
        }
      }
      .confirmationDialog("Disconnect this host?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
        Button("Disconnect Host", role: .destructive) { model.disconnect() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("Your personal data stays on this device. After restarting Zorid, pair and download your app again to reopen it.")
      }
      .sheet(isPresented: $scanning) { scanner }
    }
    .tint(Color(red: 0.03, green: 0.43, blue: 0.40))
  }

  private var setupSection: some View {
    Section {
      Label {
        VStack(alignment: .leading, spacing: 6) {
          Text("Set up your app").font(.headline)
          Text("Connect your computer to install an app. Once downloaded, it opens directly, even offline.")
            .font(.subheadline).foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: "app.badge").foregroundStyle(.tint)
      }
      .padding(.vertical, 4)
      .accessibilityElement(children: .combine)
    }
  }

  private var connectionSection: some View {
    Section {
      Label {
        VStack(alignment: .leading, spacing: 3) {
          Text(model.hostName ?? "No host paired")
          Text(model.hostName == nil ? "Pair your computer to get started" : "Paired computer")
            .font(.subheadline).foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: "laptopcomputer").foregroundStyle(.tint)
      }
      .accessibilityElement(children: .combine)
      if let origin = model.origin {
        VStack(alignment: .leading, spacing: 4) {
          Text("Trusted Host").font(.subheadline).foregroundStyle(.secondary)
          Text(origin).font(.footnote).textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
      }
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        if model.busy {
          ProgressView().accessibilityHidden(true)
        } else if model.downloaded {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint).accessibilityHidden(true)
        }
        Text(model.status).font(.subheadline).foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
    } header: {
      Text("Connection")
    } footer: {
      if model.origin == nil {
        Text("This installation has no update host configured. Install a Zorid build configured for your computer.")
      }
    }
  }

  private func errorSection(_ message: String) -> some View {
    Section {
      Label {
        VStack(alignment: .leading, spacing: 4) {
          Text("Needs Attention").font(.subheadline.weight(.semibold))
          Text(message).font(.subheadline).foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
      }
      .accessibilityElement(children: .combine)
    }
  }

  private var pairingSection: some View {
    Section {
      Button(action: requestCamera) {
        Label("Scan QR Code", systemImage: "qrcode.viewfinder")
      }
      .accessibilityHint("Scan the pairing code shown on your computer")
      TextField("Paste pairing link", text: $pairingLink, axis: .vertical)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
        .lineLimit(2...4)
        .focused($pairingLinkFocused)
        .privacySensitive()
        .accessibilityLabel("Pairing link")
        .accessibilityHint("Paste the Zorid pairing link generated on your computer")
      Button(action: pairHost) {
        Label("Pair Host", systemImage: "link")
      }
      .disabled(pairingLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    } header: {
      Text(model.hostName == nil ? "Pair a Host" : "Pair Again")
    } footer: {
      Text("Generate a pairing code on your computer, then scan it or paste its link. Pairing lets that computer install and update your app.")
    }
    .disabled(model.busy)
  }

  private var updateSection: some View {
    Section {
      Button {
        pairingLinkFocused = false
        model.checkAndDownload(automaticallyReload: !model.hasApp)
      } label: {
        Label("Check for Updates", systemImage: "arrow.down.circle")
      }
      .accessibilityHint("Check your paired computer and download an available update")
      .disabled(model.busy || !model.updatesEnabled)
      if model.downloaded {
        Button { model.reload() } label: { Label("Reload App", systemImage: "arrow.clockwise") }
          .accessibilityHint("Open the downloaded version of your app")
          .disabled(model.busy)
      }
    } header: {
      Text("App Updates")
    } footer: {
      if !model.updatesEnabled {
        Text("App updates are unavailable in this installation.")
      } else if model.hasApp {
        Text("Updates download to this device. Reload when you’re ready to open the new version.")
      } else {
        Text("Your first app opens automatically after it downloads.")
      }
    }
  }

  private var disconnectSection: some View {
    Section {
      Button(role: .destructive) { confirmingDisconnect = true } label: {
        Label("Disconnect Host", systemImage: "xmark.circle")
      }
      .disabled(model.busy)
    } footer: {
      Text("Removes the saved connection. Your personal data stays saved; after restarting, you’ll need to pair and download the app again.")
    }
  }

  private var accessSection: some View {
    Section("Open Settings") {
      Label {
        VStack(alignment: .leading, spacing: 3) {
          Text("Three-Finger Hold")
          Text("Hold anywhere on the screen for one second.")
            .font(.subheadline).foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: "hand.tap").foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      Label("Shake iPhone", systemImage: "iphone.radiowaves.left.and.right")
      Label {
        VStack(alignment: .leading, spacing: 3) {
          Text("Home Screen Quick Action")
          Text("Touch and hold Zorid’s app icon, then choose Zorid Settings.")
            .font(.subheadline).foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: "app").foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
    }
  }

  private var scanner: some View {
    NavigationStack {
      ZoridQRScanner(onCode: { code in
        scanning = false
        model.pair(code)
      }, onFailure: {
        scanning = false
        model.reportCameraFailure("Camera could not start. Paste your pairing link instead.")
      })
      .ignoresSafeArea(edges: .bottom)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        Text("Point your camera at the pairing QR code on your computer.")
          .font(.subheadline).multilineTextAlignment(.center)
          .frame(maxWidth: .infinity).padding()
          .background(.regularMaterial)
      }
      .navigationTitle("Scan Pairing Code")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
    }
    .presentationDragIndicator(.visible)
  }

  private func pairHost() {
    pairingLinkFocused = false
    let link = pairingLink
    pairingLink = ""
    model.pair(link)
  }

  private func requestCamera() {
    pairingLinkFocused = false
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
