const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
const plist = require('@expo/plist').default;
const groupIdentifier = 'group.app.zorid.mobile';
const coreSources = ['ZoridScreenTimePlan.swift', 'ZoridScreenTimeController.swift', 'ZoridScreenTimeShield.swift'];
const extensions = [
  { name: 'ZoridFocusMonitor', bundle: 'app.zorid.mobile.focus-monitor', point: 'com.apple.deviceactivity.monitor-extension', display: 'Zorid Focus Monitor' },
  { name: 'ZoridShieldConfiguration', bundle: 'app.zorid.mobile.shield-configuration', point: 'com.apple.ManagedSettingsUI.shield-configuration-service', display: 'Zorid Focus Shield' },
  { name: 'ZoridShieldAction', bundle: 'app.zorid.mobile.shield-action', point: 'com.apple.ManagedSettings.shield-action-service', display: 'Zorid Focus Shield Actions' },
];

function entitlements(original = {}) {
  return { ...original, 'com.apple.developer.family-controls': true,
    'com.apple.security.application-groups': [...new Set([...(original['com.apple.security.application-groups'] ?? []), groupIdentifier])] };
}

function configureProject(project, config) {
  for (const extension of extensions) configureExtension(project, config, extension);
  return project;
}

function configureExtension(project, config, { name: targetName, bundle: bundleIdentifier }) {
  let target = project.pbxTargetByName(targetName) ?? project.pbxTargetByName(`"${targetName}"`);
  let uuid = Object.entries(project.pbxNativeTargetSection()).find(([, value]) => value === target)?.[0];
  if (!target) {
    const created = project.addTarget(targetName, 'app_extension', targetName, bundleIdentifier);
    target = created.pbxNativeTarget;
    uuid = created.uuid;
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', uuid);
  }
  // Project-relative paths keep the shared source filenames distinct across
  // targets. A group with no directory path also upgrades earlier prebuilds.
  const sourcePaths = [...coreSources, `${targetName}.swift`].map(file => `${targetName}/${file}`);
  const phases = project.hash.project.objects.PBXSourcesBuildPhase ?? {};
  const sourcePhase = target.buildPhases.find(phase => phase.comment === 'Sources');
  const currentPaths = sourcePhase ? phases[sourcePhase.value].files.map(file =>
    project.pbxFileReferenceSection()[project.pbxBuildFileSection()[file.value].fileRef].path.replaceAll('"', '')) : [];
  if (JSON.stringify(currentPaths) !== JSON.stringify(sourcePaths)) {
    target.buildPhases = target.buildPhases.filter(phase => phase.comment !== 'Sources');
    project.addBuildPhase(sourcePaths, 'PBXSourcesBuildPhase', 'Sources', uuid);
  }
  const groups = project.hash.project.objects.PBXGroup;
  let group = Object.values(groups).find(value => value && typeof value === 'object' && value.name === targetName);
  if (!group) {
    const created = project.addPbxGroup([], targetName);
    group = created.pbxGroup;
    project.addToPbxGroup(created.uuid, project.getFirstProject().firstProject.mainGroup);
  }
  delete group.path;
  const files = [`${targetName}/Info.plist`, `${targetName}/${targetName}.entitlements`, ...sourcePaths];
  // addPbxGroup reuses file references already created by addBuildPhase.
  const temporary = project.addPbxGroup(files, `${targetName}Files`);
  group.children = temporary.pbxGroup.children;
  delete groups[temporary.uuid];
  delete groups[`${temporary.uuid}_comment`];
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList];
  for (const item of list.buildConfigurations) {
    const settings = project.pbxXCBuildConfigurationSection()[item.value].buildSettings;
    Object.assign(settings, {
      INFOPLIST_FILE: `${targetName}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${targetName}/${targetName}.entitlements`,
      PRODUCT_BUNDLE_IDENTIFIER: bundleIdentifier,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      CURRENT_PROJECT_VERSION: String(config.ios?.buildNumber ?? '1'),
      MARKETING_VERSION: config.version ?? '0.1.0',
      IPHONEOS_DEPLOYMENT_TARGET: '16.4',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SWIFT_VERSION: '5.0',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      SKIP_INSTALL: 'YES',
      GENERATE_INFOPLIST_FILE: 'NO',
      ...(config.ios?.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
    });
  }
}

async function generateSources(projectRoot, platformRoot) {
  for (const extension of extensions) await generateExtension(projectRoot, platformRoot, extension);
}

async function generateExtension(projectRoot, platformRoot, { name: targetName, display, point }) {
  const targetRoot = path.join(platformRoot, targetName);
  await fs.mkdir(targetRoot, { recursive: true });
  for (const source of coreSources) {
    await fs.copyFile(path.join(projectRoot, 'modules/zorid-screen-time/ios', source), path.join(targetRoot, source));
  }
  await fs.copyFile(path.join(projectRoot, `native/screen-time/${targetName}.swift`), path.join(targetRoot, `${targetName}.swift`));
  await fs.writeFile(path.join(targetRoot, `${targetName}.entitlements`), plist.build(entitlements()));
  await fs.writeFile(path.join(targetRoot, 'Info.plist'), plist.build({
    CFBundleDisplayName: display, CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleName: '$(PRODUCT_NAME)',
    CFBundlePackageType: 'XPC!', CFBundleShortVersionString: '$(MARKETING_VERSION)', CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    NSExtension: { NSExtensionPointIdentifier: point,
      NSExtensionPrincipalClass: `$(PRODUCT_MODULE_NAME).${targetName}` },
  }));
}

async function patchWidgetEntitlements(platformRoot) {
  // The widget intent executes the same native Screen Time action path. Its own
  // signed extension therefore also needs the Family Controls entitlement.
  const widgetsEntitlements = path.join(platformRoot, 'ExpoWidgetsTarget/ExpoWidgetsTarget.entitlements');
  let original;
  try { original = plist.parse(await fs.readFile(widgetsEntitlements, 'utf8')); }
  catch (error) { throw new Error(`Generate Expo Widgets before Screen Time: ${error.code ?? 'invalid entitlements'}`); }
  await fs.writeFile(widgetsEntitlements, plist.build(entitlements(original)));
}

function withZoridScreenTime(config) {
  config = withEntitlementsPlist(config, mod => {
    mod.modResults = entitlements(mod.modResults);
    return mod;
  });
  config = withDangerousMod(config, ['ios', async mod => {
    await generateSources(mod.modRequest.projectRoot, mod.modRequest.platformProjectRoot);
    return mod;
  }]);
  return withXcodeProject(config, async mod => {
    // Dangerous mods execute in wrapper order. Wait until the xcode-project mod,
    // after all file generation, before patching Expo's generated entitlements.
    await patchWidgetEntitlements(mod.modRequest.platformProjectRoot);
    configureProject(mod.modResults, mod);
    return mod;
  });
}
module.exports = withZoridScreenTime;
module.exports.entitlements = entitlements;
module.exports.configureProject = configureProject;
module.exports.generateSources = generateSources;
module.exports.patchWidgetEntitlements = patchWidgetEntitlements;
module.exports.extensions = extensions;
