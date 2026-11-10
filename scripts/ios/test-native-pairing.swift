import Foundation

// Runs against the actual native parser on a GitHub macOS runner, without
// touching Keychain, the network, or any real pairing credentials.
@main
enum NativePairingChecks {
  static func main() throws {
    let origin = "https://host.example.ts.net:10000"
    let token = String(repeating: "a", count: 43)
    func link(_ host: String, _ value: String) -> String {
      var parts = URLComponents(string: "zorid://pair")!
      parts.queryItems = [URLQueryItem(name: "url", value: host), URLQueryItem(name: "token", value: value)]
      return parts.string!
    }
    func rejects(_ value: String) {
      do {
        _ = try ZoridPairing.offer(value, trustedOrigin: origin)
        fatalError("Native parser accepted an invalid pairing link")
      } catch { /* Expected: keep raw input out of logs. */ }
    }
    let goodLink = link(origin, token)
    let parsed = try ZoridPairing.offer(goodLink, trustedOrigin: origin)
    precondition(parsed == token)
    for host in ["http://host.example.ts.net:10000", "https://other.example.ts.net:10000",
                 "https://host.example.ts.net", "\(origin)/other", "\(origin)?x=1",
                 "https://user@host.example.ts.net:10000", "\(origin)#fragment"] {
      rejects(link(host, token))
    }
    for value in ["", "short", token + "\n", token + " ", String(repeating: "a", count: 129)] {
      rejects(link(origin, value))
    }
    rejects(goodLink + "&token=" + token)
    rejects(goodLink + "&unexpected=value")
    rejects(goodLink.replacingOccurrences(of: "zorid://pair?", with: "zorid://pair/other?"))
    rejects(goodLink.replacingOccurrences(of: "zorid://", with: "https://"))
    rejects(goodLink + "#fragment")
    let valid = ZoridPairedHost(deviceId: "test-device-id", token: token, hostName: "Test host", updateUrl: "\(origin)/updates")
    _ = try ZoridPairing.validate(valid, origin: origin)
    for invalid in [
      ZoridPairedHost(deviceId: "id\n", token: token, hostName: "Test", updateUrl: valid.updateUrl),
      ZoridPairedHost(deviceId: valid.deviceId, token: token + "\n", hostName: "Test", updateUrl: valid.updateUrl),
      ZoridPairedHost(deviceId: valid.deviceId, token: token, hostName: " ", updateUrl: valid.updateUrl),
      ZoridPairedHost(deviceId: valid.deviceId, token: token, hostName: "Test", updateUrl: "https://other.example.ts.net/updates"),
      ZoridPairedHost(deviceId: valid.deviceId, token: token, hostName: "Test", updateUrl: "\(origin)/updates/other"),
    ] {
      do {
        _ = try ZoridPairing.validate(invalid, origin: origin)
        fatalError("Native parser accepted an invalid host response")
      } catch { /* Expected. */ }
    }
    precondition(ZoridPairing.origin("https://HOST.example.ts.net:443/") == "https://host.example.ts.net")
    precondition(ZoridPairing.origin("\(origin)/updates", updateEndpoint: true) == origin)
    precondition(ZoridPairing.origin("\(origin)/updates?x=1", updateEndpoint: true) == nil)
    print("Native pairing validation passed: valid links/responses, host pinning, malformed inputs and bounded credentials.")
    checkShakeDetection()
  }

  private static func checkShakeDetection() {
    let forward = SIMD3<Double>(1.6, 0.2, 0)
    let backward = -forward
    var detector = ZoridShakeDetector()
    precondition(!detector.record(SIMD3(0.6, 0, 0), at: 0))
    precondition(!detector.record(SIMD3(-0.6, 0, 0), at: 0.1))
    precondition(!detector.record(forward, at: 1))
    precondition(!detector.record(forward, at: 1.1))
    precondition(!detector.record(backward, at: 1.7))
    precondition(detector.record(forward, at: 1.9))
    precondition(!detector.record(backward, at: 2.1))
    precondition(!detector.record(forward, at: 2.2))
    precondition(!detector.record(backward, at: 3))
    precondition(detector.record(forward, at: 3.2))
    print("Native shake detection passed for small movement, single-direction motion, reversals and cooldown.")
  }
}
