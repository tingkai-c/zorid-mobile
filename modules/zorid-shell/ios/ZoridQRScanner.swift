import SwiftUI
import UIKit
import AVFoundation

struct ZoridQRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void
  let onFailure: () -> Void

  func makeUIViewController(context: Context) -> ZoridScannerController {
    ZoridScannerController(onCode: onCode, onFailure: onFailure)
  }

  func updateUIViewController(_ uiViewController: ZoridScannerController, context: Context) {}

  static func dismantleUIViewController(_ uiViewController: ZoridScannerController, coordinator: ()) {
    uiViewController.stop()
  }
}

final class ZoridScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let capture = AVCaptureSession()
  private let captureQueue = DispatchQueue(label: "app.zorid.mobile.qr-capture")
  private var preview: AVCaptureVideoPreviewLayer?
  private var consumed = false
  private var cancelled = false
  private let onCode: (String) -> Void
  private let onFailure: () -> Void

  init(onCode: @escaping (String) -> Void, onFailure: @escaping () -> Void) {
    self.onCode = onCode
    self.onFailure = onFailure
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("Use init(onCode:onFailure:)") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    view.accessibilityLabel = "Camera preview. Point at your host’s Zorid pairing QR code."
    let layer = AVCaptureVideoPreviewLayer(session: capture)
    layer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(layer)
    preview = layer
    captureQueue.async { [weak self] in self?.configureAndStart() }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    stop()
  }

  func stop() {
    // Serializing cancellation with configuration prevents a dismissed camera
    // from starting late after its controller has disappeared.
    captureQueue.async { [weak self] in
      self?.cancelled = true
      self?.capture.stopRunning()
    }
  }

  private func configureAndStart() {
    guard !cancelled,
      let camera = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: camera), capture.canAddInput(input)
    else { fail(); return }
    capture.beginConfiguration()
    capture.addInput(input)
    let metadata = AVCaptureMetadataOutput()
    guard capture.canAddOutput(metadata) else {
      capture.commitConfiguration()
      fail()
      return
    }
    capture.addOutput(metadata)
    metadata.setMetadataObjectsDelegate(self, queue: .main)
    guard metadata.availableMetadataObjectTypes.contains(.qr) else {
      capture.commitConfiguration()
      fail()
      return
    }
    metadata.metadataObjectTypes = [.qr]
    capture.commitConfiguration()
    capture.startRunning()
  }

  private func fail() {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.consumed else { return }
      self.consumed = true
      self.onFailure()
    }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput,
                      didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
    guard !consumed,
      let code = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first
    else { return }
    consumed = true
    stop()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onCode(code)
  }
}
