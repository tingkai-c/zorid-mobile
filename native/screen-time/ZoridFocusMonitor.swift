import DeviceActivity

final class ZoridFocusMonitor: DeviceActivityMonitor {
  override func intervalDidEnd(for activity: DeviceActivityName) {
    super.intervalDidEnd(for: activity)
    ZoridScreenTimeController.shared.intervalEnded(activity)
  }
}
