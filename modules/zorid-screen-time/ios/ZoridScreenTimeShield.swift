import Foundation

public enum ZoridShieldError: LocalizedError {
  case invalidConfiguration, unsupportedOpenApp, unsupportedSubmenu, invalidImage
  public var errorDescription: String? {
    switch self {
    case .invalidConfiguration: return "Invalid shield configuration. Use supported native fields and at most 256 KiB of configuration data."
    case .unsupportedOpenApp: return "Opening Zorid from a shield requires iOS 26.5 or later."
    case .unsupportedSubmenu: return "Shield button submenus require iOS 26.4 or later."
    case .invalidImage: return "Use a valid PNG of at most 128 KiB and 1024 pixels per side."
    }
  }
}

// Apple's nine public ShieldConfiguration fields, plus native action responses.
// This model stays Foundation-only for real Swift tests on the macOS runner.
public struct ZoridShieldStyle: Codable {
  public enum Color: Codable {
    case fixed(String)
    case dynamic(light: String, dark: String)
    private enum Keys: String, CodingKey { case light, dark }
    public init(from decoder: Decoder) throws {
      if let value = try? decoder.singleValueContainer().decode(String.self) {
        guard Self.validHex(value) else { throw ZoridShieldError.invalidConfiguration }
        self = .fixed(value.uppercased())
      } else {
        try ZoridShieldStyle.checkKeys(decoder, allowed: ["light", "dark"])
        let values = try decoder.container(keyedBy: Keys.self)
        let light = try values.decode(String.self, forKey: .light)
        let dark = try values.decode(String.self, forKey: .dark)
        guard Self.validHex(light), Self.validHex(dark) else { throw ZoridShieldError.invalidConfiguration }
        self = .dynamic(light: light.uppercased(), dark: dark.uppercased())
      }
    }
    public func encode(to encoder: Encoder) throws {
      switch self {
      case .fixed(let value): var values = encoder.singleValueContainer(); try values.encode(value)
      case .dynamic(let light, let dark):
        var values = encoder.container(keyedBy: Keys.self)
        try values.encode(light, forKey: .light); try values.encode(dark, forKey: .dark)
      }
    }
    private static func validHex(_ value: String) -> Bool {
      (value.count == 7 || value.count == 9) && value.first == "#"
        && value.dropFirst().allSatisfy { $0.isASCII && $0.isHexDigit }
    }
  }
  public struct Label: Codable {
    public let text: String
    public let color: Color
    private enum Keys: String, CodingKey { case text, color }
    public init(from decoder: Decoder) throws {
      try ZoridShieldStyle.checkKeys(decoder, allowed: ["text", "color"])
      let values = try decoder.container(keyedBy: Keys.self)
      text = try values.decode(String.self, forKey: .text)
      color = try values.decode(Color.self, forKey: .color)
    }
  }
  public enum Icon: Codable {
    case symbol(String)
    case png(Data)
    private enum Keys: String, CodingKey { case systemName, pngBase64 }
    public init(from decoder: Decoder) throws {
      try ZoridShieldStyle.checkKeys(decoder, allowed: ["systemName", "pngBase64"])
      let values = try decoder.container(keyedBy: Keys.self)
      guard values.contains(.systemName) != values.contains(.pngBase64) else { throw ZoridShieldError.invalidConfiguration }
      if values.contains(.systemName) { self = .symbol(try values.decode(String.self, forKey: .systemName)) }
      else {
        let encoded = try values.decode(String.self, forKey: .pngBase64)
        guard encoded.utf8.count <= 174_764, let data = Data(base64Encoded: encoded), data.count <= 131_072,
              data.base64EncodedString() == encoded, data.count >= 33,
              data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              Array(data[8..<16]) == [0, 0, 0, 13, 73, 72, 68, 82] else { throw ZoridShieldError.invalidImage }
        let width = data[16..<20].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let height = data[20..<24].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard (1...1024).contains(width), (1...1024).contains(height) else { throw ZoridShieldError.invalidImage }
        self = .png(data)
      }
    }
    public func encode(to encoder: Encoder) throws {
      var values = encoder.container(keyedBy: Keys.self)
      switch self {
      case .symbol(let name): try values.encode(name, forKey: .systemName)
      case .png(let data): try values.encode(data.base64EncodedString(), forKey: .pngBase64)
      }
    }
  }
  public struct Actions: Codable {
    public let primary: String?
    public let secondary: String?
    public let submenu: [String]?
    private enum Keys: String, CodingKey { case primary, secondary, submenu }
    public init(from decoder: Decoder) throws {
      try ZoridShieldStyle.checkKeys(decoder, allowed: ["primary", "secondary", "submenu"])
      let values = try decoder.container(keyedBy: Keys.self)
      primary = try values.decodeIfPresent(String.self, forKey: .primary)
      secondary = try values.decodeIfPresent(String.self, forKey: .secondary)
      submenu = try values.decodeIfPresent([String].self, forKey: .submenu)
      let responses = [primary, secondary].compactMap { $0 } + (submenu ?? [])
      guard responses.allSatisfy({ ["close", "none", "stay", "defer", "openApp"].contains($0) }) else {
        throw ZoridShieldError.invalidConfiguration
      }
    }
  }
  public static let blurStyles: Set<String> = [
    "extraLight", "light", "dark", "regular", "prominent",
    "systemUltraThinMaterial", "systemThinMaterial", "systemMaterial", "systemThickMaterial", "systemChromeMaterial",
    "systemUltraThinMaterialLight", "systemThinMaterialLight", "systemMaterialLight", "systemThickMaterialLight", "systemChromeMaterialLight",
    "systemUltraThinMaterialDark", "systemThinMaterialDark", "systemMaterialDark", "systemThickMaterialDark", "systemChromeMaterialDark"
  ]
  public let backgroundBlurStyle: String?
  public let backgroundColor: Color?
  public let icon: Icon?
  public let title: Label?
  public let subtitle: Label?
  public let primaryButtonLabel: Label?
  public let primaryButtonBackgroundColor: Color?
  public let secondaryButtonLabel: Label?
  public let secondaryButtonSubmenuItems: [String]?
  public let actions: Actions?
  private enum Keys: String, CodingKey {
    case backgroundBlurStyle, backgroundColor, icon, title, subtitle, primaryButtonLabel,
         primaryButtonBackgroundColor, secondaryButtonLabel, secondaryButtonSubmenuItems, actions
  }
  public init(from decoder: Decoder) throws {
    try Self.checkKeys(decoder, allowed: ["backgroundBlurStyle", "backgroundColor", "icon", "title", "subtitle", "primaryButtonLabel",
      "primaryButtonBackgroundColor", "secondaryButtonLabel", "secondaryButtonSubmenuItems", "actions"])
    let values = try decoder.container(keyedBy: Keys.self)
    backgroundBlurStyle = try values.decodeIfPresent(String.self, forKey: .backgroundBlurStyle)
    if let style = backgroundBlurStyle, !Self.blurStyles.contains(style) { throw ZoridShieldError.invalidConfiguration }
    backgroundColor = try values.decodeIfPresent(Color.self, forKey: .backgroundColor)
    icon = try values.decodeIfPresent(Icon.self, forKey: .icon)
    title = try values.decodeIfPresent(Label.self, forKey: .title)
    subtitle = try values.decodeIfPresent(Label.self, forKey: .subtitle)
    primaryButtonLabel = try values.decodeIfPresent(Label.self, forKey: .primaryButtonLabel)
    primaryButtonBackgroundColor = try values.decodeIfPresent(Color.self, forKey: .primaryButtonBackgroundColor)
    secondaryButtonLabel = try values.decodeIfPresent(Label.self, forKey: .secondaryButtonLabel)
    secondaryButtonSubmenuItems = try values.decodeIfPresent([String].self, forKey: .secondaryButtonSubmenuItems)
    actions = try values.decodeIfPresent(Actions.self, forKey: .actions)
    if let items = secondaryButtonSubmenuItems {
      guard (1...3).contains(items.count) else { throw ZoridShieldError.invalidConfiguration }
      if let responses = actions?.submenu, responses.count != items.count { throw ZoridShieldError.invalidConfiguration }
    } else if actions?.submenu != nil { throw ZoridShieldError.invalidConfiguration }
  }
  public static func parse(_ json: String) throws -> ZoridShieldStyle {
    guard json.utf8.count <= 262_144 else { throw ZoridShieldError.invalidConfiguration }
    do { return try JSONDecoder().decode(Self.self, from: Data(json.utf8)) }
    catch let error as ZoridShieldError { throw error }
    catch { throw ZoridShieldError.invalidConfiguration }
  }
  public var needsOpenApp: Bool {
    [actions?.primary, actions?.secondary].compactMap { $0 }.contains("openApp") || actions?.submenu?.contains("openApp") == true
  }
  public func action(secondary: Bool) -> String { secondary ? actions?.secondary ?? "none" : actions?.primary ?? "close" }
  public func submenuAction(at index: Int) -> String {
    guard let actions = actions?.submenu, actions.indices.contains(index) else { return "none" }
    return actions[index]
  }
  // An empty configuration delegates every appearance property to Apple's system
  // defaults. It is intentionally independent of any downloaded tool or timer.
  public static let fallback = try! ZoridShieldStyle.parse("{}")
  private struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
  }
  fileprivate static func checkKeys(_ decoder: Decoder, allowed: Set<String>) throws {
    let keys = try decoder.container(keyedBy: AnyKey.self).allKeys.map(\.stringValue)
    guard Set(keys).isSubset(of: allowed) else { throw ZoridShieldError.invalidConfiguration }
  }
}

struct ZoridShieldDocument: Codable {
  let version: Int
  let style: ZoridShieldStyle
  init(style: ZoridShieldStyle) { version = 1; self.style = style }
  private enum Keys: String, CodingKey { case version, style }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: Keys.self)
    version = try values.decode(Int.self, forKey: .version)
    guard version == 1 else { throw ZoridShieldError.invalidConfiguration }
    style = try values.decode(ZoridShieldStyle.self, forKey: .style)
  }
}

public enum ZoridShieldResolution {
  // Configuration callbacks may include app+category while an action callback
  // includes only one token. Resolve without either context so the visible
  // button and its response always use the same policy-independent choice.
  public static func resolve(_ activeStyles: [ZoridShieldStyle]) -> ZoridShieldStyle {
    guard let first = activeStyles.first else { return .fallback }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let canonical = try? encoder.encode(first) else { return .fallback }
    for style in activeStyles.dropFirst() {
      guard let candidate = try? encoder.encode(style), candidate == canonical else { return .fallback }
    }
    return first
  }
}
