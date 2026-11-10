const { withDangerousMod, withInfoPlist } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const shortcutType = 'app.zorid.mobile.host-settings';
const start = '  // @generated begin zorid-shell';
const end = '  // @generated end zorid-shell';
const hooks = `${start}
  override func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    ZoridShellCoordinator.shared.attach(to: window, shortcut: connectionOptions.shortcutItem)
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    super.sceneDidBecomeActive(scene)
    ZoridShellCoordinator.shared.attach(to: window)
  }

  override func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
    if ZoridShellCoordinator.shared.handleShortcut(shortcutItem) {
      completionHandler(true)
    } else {
      super.windowScene(windowScene, performActionFor: shortcutItem, completionHandler: completionHandler)
    }
  }
${end}`;

function patchSceneDelegate(source) {
  if (!source.includes('class SceneDelegate: ExpoAppSceneDelegate')) {
    throw new Error('Zorid shell requires the Expo scene-based SceneDelegate template.');
  }
  const marker = '  // Extension point for config plugins.';
  const first = source.indexOf(start);
  const last = source.indexOf(end);
  if ((first >= 0) !== (last >= 0) || (first >= 0 && last < first)) {
    throw new Error('Incomplete Zorid shell SceneDelegate markers.');
  }
  if (first >= 0) source = source.slice(0, first) + hooks + source.slice(last + end.length);
  else if (source.includes(marker)) source = source.replace(marker, hooks);
  else throw new Error('Missing Expo SceneDelegate extension point; inspect native shell integration.');
  // Match Expo's generated module provider under Swift 6 import access checks.
  const moduleImport = /^(?:internal )?import ZoridShell$/m;
  if (moduleImport.test(source)) source = source.replace(moduleImport, 'internal import ZoridShell');
  else source = `internal import ZoridShell\n${source}`;
  return source;
}

function withZoridShell(config) {
  config = withInfoPlist(config, (mod) => {
    const items = mod.modResults.UIApplicationShortcutItems ?? [];
    mod.modResults.UIApplicationShortcutItems = [
      ...items.filter((item) => item.UIApplicationShortcutItemType !== shortcutType),
      { UIApplicationShortcutItemType: shortcutType, UIApplicationShortcutItemTitle: 'Zorid Settings', UIApplicationShortcutItemIconSymbolName: 'gearshape' },
    ];
    return mod;
  });
  return withDangerousMod(config, ['ios', async (mod) => {
    const scenePath = path.join(mod.modRequest.platformProjectRoot, mod.modRequest.projectName, 'SceneDelegate.swift');
    await fs.writeFile(scenePath, patchSceneDelegate(await fs.readFile(scenePath, 'utf8')));
    return mod;
  }]);
}

module.exports = withZoridShell;
module.exports.patchSceneDelegate = patchSceneDelegate;
