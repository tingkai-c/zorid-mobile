import Foundation

@main struct ShieldConfigurationTests {
  static func main() throws {
    var checks = 0
    func check(_ value: Bool) { precondition(value); checks += 1 }
    func encoded(_ value: [String: Any]) throws -> String {
      String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    func parse(_ value: [String: Any]) throws -> ZoridShieldStyle { try .parse(encoded(value)) }
    func reject(_ value: [String: Any]) throws {
      do { _ = try parse(value); preconditionFailure("Invalid configuration accepted") }
      catch is ZoridShieldError { checks += 1 }
    }
    let defaults = try parse([:])
    check(defaults.title == nil && defaults.subtitle == nil && defaults.primaryButtonLabel == nil)
    check(defaults.secondaryButtonLabel == nil && defaults.backgroundBlurStyle == nil && defaults.icon == nil)
    check(defaults.action(secondary: false) == "close" && defaults.action(secondary: true) == "none")
    let nullable: [String: Any] = ["backgroundBlurStyle": NSNull(), "backgroundColor": NSNull(), "icon": NSNull(),
      "title": NSNull(), "subtitle": NSNull(), "primaryButtonLabel": NSNull(), "primaryButtonBackgroundColor": NSNull(),
      "secondaryButtonLabel": NSNull(), "secondaryButtonSubmenuItems": NSNull(), "actions": NSNull()]
    let nilStyle = try parse(nullable)
    check(nilStyle.title == nil && nilStyle.actions == nil && nilStyle.secondaryButtonSubmenuItems == nil)
    let full: [String: Any] = ["backgroundBlurStyle": "systemMaterial", "backgroundColor": ["light": "#FFFFFF80", "dark": "#000000FF"],
      "icon": ["systemName": "hourglass"], "title": ["text": " Title\nwith\ttabs ", "color": "#abcdef80"],
      "subtitle": ["text": "", "color": "#FFFFFF"], "primaryButtonLabel": ["text": "Close", "color": "#FFFFFF"],
      "primaryButtonBackgroundColor": "#10203040", "secondaryButtonLabel": ["text": "More", "color": "#123456"],
      "secondaryButtonSubmenuItems": ["Stay", "Refresh", "Open Zorid"],
      "actions": ["primary": "close", "secondary": "none", "submenu": ["stay", "defer", "openApp"]]]
    let style = try parse(full)
    check(style.title?.text == " Title\nwith\ttabs ")
    check(style.subtitle?.text == "")
    check(style.needsOpenApp)
    check(style.submenuAction(at: 0) == "stay" && style.submenuAction(at: 1) == "defer" && style.submenuAction(at: 2) == "openApp")
    check(style.submenuAction(at: -1) == "none" && style.submenuAction(at: 3) == "none")
    let unboundMenu = try parse(["secondaryButtonSubmenuItems": ["First", "Second"]])
    check(unboundMenu.secondaryButtonSubmenuItems?.count == 2)
    check(unboundMenu.submenuAction(at: 0) == "none" && unboundMenu.submenuAction(at: 1) == "none")
    check(try parse(["secondaryButtonSubmenuItems": ["First"], "actions": ["primary": "close"]]).submenuAction(at: 0) == "none")
    if case .fixed(let color)? = style.title?.color { check(color == "#ABCDEF80") } else { preconditionFailure("RGBA not decoded") }
    if case .dynamic(let light, let dark)? = style.backgroundColor { check(light == "#FFFFFF80" && dark == "#000000FF") } else { preconditionFailure("Dynamic color not decoded") }
    let roundTrip = try JSONDecoder().decode(ZoridShieldDocument.self, from: JSONEncoder().encode(ZoridShieldDocument(style: style)))
    check(roundTrip.version == 1 && roundTrip.style.submenuAction(at: 2) == "openApp")
    for blur in ZoridShieldStyle.blurStyles { check(try parse(["backgroundBlurStyle": blur]).backgroundBlurStyle == blur) }
    check(ZoridShieldStyle.blurStyles.count == 20)
    for response in ["close", "none", "stay", "defer", "openApp"] {
      check(try parse(["actions": ["primary": response]]).action(secondary: false) == response)
    }
    let invalidConfigurations: [[String: Any]] = [
      ["title": "wrong type"], ["title": ["text": "missing color"]], ["title": ["text": "Hi", "color": NSNull()]],
      ["title": ["text": "Hi", "color": "#123456", "fontSize": 20]], ["footer": "unsupported"],
      ["backgroundBlurStyle": "extraDark"], ["backgroundColor": "red"], ["backgroundColor": "#12345"], ["backgroundColor": "#1234567"],
      ["backgroundColor": ["light": "#FFFFFF"]], ["backgroundColor": ["light": "#FFFFFF", "dark": "#000000", "unknown": "#AAAAAA"]],
      ["icon": ["systemName": "timer", "pngBase64": "anything"]], ["icon": ["url": "https://example.com"]],
      ["actions": ["primary": "eval"]], ["actions": ["url": "zorid://app"]],
      ["secondaryButtonSubmenuItems": []], ["secondaryButtonSubmenuItems": ["A", "B", "C", "D"]],
      ["secondaryButtonSubmenuItems": ["A", "B"], "actions": ["submenu": ["none"]]],
      ["actions": ["submenu": ["close"]]]
    ]
    for invalid in invalidConfigurations { try reject(invalid) }
    let signature = Data([137, 80, 78, 71, 13, 10, 26, 10])
    let png = signature + Data([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0])
    let header = try parse(["icon": ["pngBase64": png.base64EncodedString()]])
    if case .png(let bytes)? = header.icon { check(bytes == png) } else { preconditionFailure("PNG not decoded") }
    // Full PNG dimensions/data validity is additionally checked by ImageIO on iOS.
    try reject(["icon": ["pngBase64": signature.base64EncodedString()]])
    var oversized = png
    oversized.replaceSubrange(16..<20, with: [0, 0, 4, 1])
    try reject(["icon": ["pngBase64": oversized.base64EncodedString()]])
    try reject(["icon": ["pngBase64": Data(repeating: 1, count: 131_073).base64EncodedString()]])
    try reject(["icon": ["pngBase64": "not base64"]])
    check(try parse(["title": ["text": String(repeating: "x", count: 5000), "color": "#FFFFFF"]]).title?.text.count == 5000)
    try reject(["title": ["text": String(repeating: "x", count: 262_145), "color": "#FFFFFF"]])
    let future = Data("{\"version\":2,\"style\":{}}".utf8)
    do { _ = try JSONDecoder().decode(ZoridShieldDocument.self, from: future); preconditionFailure("Unknown document version accepted") }
    catch { checks += 1 }
    func matches(_ mode: String, _ application: Int?, _ category: String?) -> Bool {
      ZoridShieldMatch.matches(mode: mode, application: application, category: category, applications: [1], categories: ["social"])
    }
    check(matches("blocklist", 1, nil)); check(!matches("blocklist", 2, nil))
    check(matches("blocklist", 2, "social")); check(!matches("blocklist", 2, "work")); check(matches("blocklist", nil, "social"))
    check(!matches("allowlist", 1, "social")); check(matches("allowlist", 2, "social")); check(matches("allowlist", nil, "social"))
    check(!matches("allowlist", nil, nil)); check(!matches("unknown", 1, "social"))
    print("Screen Time shield configuration checks passed: \(checks)")
  }
}
