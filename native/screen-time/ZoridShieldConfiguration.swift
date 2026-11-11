import ManagedSettings
import ManagedSettingsUI
import UIKit

final class ZoridShieldConfiguration: ShieldConfigurationDataSource {
  override func configuration(shielding application: Application) -> ShieldConfiguration {
    render(ZoridScreenTimeController.shared.shieldStyle())
  }
  override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
    render(ZoridScreenTimeController.shared.shieldStyle())
  }
  override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration { render(.fallback) }
  override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration { render(.fallback) }

  private func render(_ style: ZoridShieldStyle) -> ShieldConfiguration {
    let blur = style.backgroundBlurStyle.flatMap(blurStyle)
    let background = style.backgroundColor.map(color)
    let title = style.title.map(label)
    let subtitle = style.subtitle.map(label)
    let primaryLabel = style.primaryButtonLabel.map(label)
    let primaryBackground = style.primaryButtonBackgroundColor.map(color)
    let secondaryLabel = style.secondaryButtonLabel.map(label)
    let icon = image(style)
    if #available(iOS 26.4, *) {
      return ShieldConfiguration(backgroundBlurStyle: blur, backgroundColor: background, icon: icon,
        title: title, subtitle: subtitle, primaryButtonLabel: primaryLabel,
        primaryButtonBackgroundColor: primaryBackground, secondaryButtonLabel: secondaryLabel,
        secondaryButtonSubmenuItems: style.secondaryButtonSubmenuItems)
    }
    return ShieldConfiguration(backgroundBlurStyle: blur, backgroundColor: background, icon: icon,
      title: title, subtitle: subtitle, primaryButtonLabel: primaryLabel,
      primaryButtonBackgroundColor: primaryBackground, secondaryButtonLabel: secondaryLabel)
  }

  private func image(_ style: ZoridShieldStyle) -> UIImage? {
    switch style.icon {
    case .symbol(let name)?: return UIImage(systemName: name)
    case .png(let data)?:
      guard (try? ZoridScreenTimeController.validateShieldImage(style)) != nil else { return nil }
      return UIImage(data: data)
    case nil: return nil
    }
  }
  private func label(_ value: ZoridShieldStyle.Label) -> ShieldConfiguration.Label {
    ShieldConfiguration.Label(text: value.text, color: color(value.color))
  }
  private func color(_ value: ZoridShieldStyle.Color) -> UIColor {
    switch value {
    case .fixed(let hex): return Self.hexColor(hex)
    case .dynamic(let light, let dark):
      return UIColor { traits in Self.hexColor(traits.userInterfaceStyle == .dark ? dark : light) }
    }
  }
  private static func hexColor(_ hex: String) -> UIColor {
    // Model validation guarantees six or eight hexadecimal digits. The fallback
    // is only for an unexpected in-process value and preserves system defaults.
    guard let value = UInt64(hex.dropFirst(), radix: 16) else { return .label }
    let rgba = hex.count == 9 ? value : (value << 8) | 255
    return UIColor(red: CGFloat((rgba >> 24) & 255) / 255,
      green: CGFloat((rgba >> 16) & 255) / 255, blue: CGFloat((rgba >> 8) & 255) / 255,
      alpha: CGFloat(rgba & 255) / 255)
  }
  private func blurStyle(_ value: String) -> UIBlurEffect.Style? {
    switch value {
    case "extraLight": return .extraLight
    case "light": return .light
    case "dark": return .dark
    case "regular": return .regular
    case "prominent": return .prominent
    case "systemUltraThinMaterial": return .systemUltraThinMaterial
    case "systemThinMaterial": return .systemThinMaterial
    case "systemMaterial": return .systemMaterial
    case "systemThickMaterial": return .systemThickMaterial
    case "systemChromeMaterial": return .systemChromeMaterial
    case "systemUltraThinMaterialLight": return .systemUltraThinMaterialLight
    case "systemThinMaterialLight": return .systemThinMaterialLight
    case "systemMaterialLight": return .systemMaterialLight
    case "systemThickMaterialLight": return .systemThickMaterialLight
    case "systemChromeMaterialLight": return .systemChromeMaterialLight
    case "systemUltraThinMaterialDark": return .systemUltraThinMaterialDark
    case "systemThinMaterialDark": return .systemThinMaterialDark
    case "systemMaterialDark": return .systemMaterialDark
    case "systemThickMaterialDark": return .systemThickMaterialDark
    case "systemChromeMaterialDark": return .systemChromeMaterialDark
    default: return nil
    }
  }
}
