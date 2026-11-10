require 'json'
require 'xcodeproj'
settings = JSON.parse(File.read(File.join(ENV.fetch('RUNNER_TEMP'), 'zorid-signing', 'profiles.json')))
project = Xcodeproj::Project.open(Dir['ios/*.xcodeproj'].fetch(0))
signable = project.targets.select { |target| ['com.apple.product-type.application', 'com.apple.product-type.app-extension'].include?(target.product_type) }
raise 'Expected app and widget extension targets' if signable.length < 2
signable.each do |target|
  target.build_configurations.each do |config|
    bundle = config.build_settings.fetch('PRODUCT_BUNDLE_IDENTIFIER')
    profile = settings['profiles'][bundle]
    raise 'Missing profile for app or extension target' if !settings['profiles'].empty? && profile.nil?
    config.build_settings['DEVELOPMENT_TEAM'] = settings.fetch('team')
    config.build_settings['CODE_SIGN_STYLE'] = profile ? 'Manual' : 'Automatic'
    config.build_settings['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] = 'Apple Distribution'
    if profile
      config.build_settings['PROVISIONING_PROFILE_SPECIFIER'] = profile
    else
      config.build_settings.delete('PROVISIONING_PROFILE_SPECIFIER')
      config.build_settings.delete('PROVISIONING_PROFILE')
    end
  end
end
project.save
