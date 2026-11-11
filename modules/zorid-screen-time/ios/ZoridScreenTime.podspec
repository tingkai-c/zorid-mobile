require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'ZoridScreenTime'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.license = package['license']
  s.author = package['author']
  s.homepage = package['homepage']
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => package['homepage'] + '.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'FamilyControls', 'ManagedSettings', 'DeviceActivity', 'SwiftUI', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'APPLICATION_EXTENSION_API_ONLY' => 'YES' }
end
