import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const { patchSceneDelegate } = createRequire(import.meta.url)('./with-zorid-shell.cjs') as {
  patchSceneDelegate: (source: string) => string;
};
const template = `internal import Expo

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}
`;

describe('native settings lifecycle integration', () => {
  test('handles cold and warm shortcuts and attaches after Expo creates its window', () => {
    const patched = patchSceneDelegate(template);
    expect(patched).toContain('internal import ZoridShell');
    expect(patched.indexOf('super.scene(scene, willConnectTo: session')).toBeLessThan(patched.indexOf('attach(to: window, shortcut:'));
    expect(patched).toContain('shortcut: connectionOptions.shortcutItem');
    expect(patched).toContain('override func sceneDidBecomeActive');
    expect(patched).toContain('override func sceneWillResignActive');
    expect(patched).toContain('stopShakeDetection()');
    expect(patched).toContain('handleShortcut(shortcutItem)');
    expect(patched).toContain('super.windowScene(windowScene, performActionFor: shortcutItem');
    expect(patched).toContain('completionHandler(true)');
  });
  test('repeated prebuilds preserve unrelated native content without duplicate hooks', () => {
    const once = patchSceneDelegate(template.replace('@objc', '// Another plugin\n@objc'));
    expect(patchSceneDelegate(once)).toBe(once);
    expect(once).toContain('// Another plugin');
    expect(patchSceneDelegate(once.replace('internal import ZoridShell', 'import ZoridShell'))).toBe(once);
  });
  test('fails explicitly on unsupported templates and damaged generated blocks', () => {
    expect(() => patchSceneDelegate('class SceneDelegate {}')).toThrow('scene-based');
    expect(() => patchSceneDelegate(template.replace('  // Extension point for config plugins.', ''))).toThrow('extension point');
    expect(() => patchSceneDelegate(`${template}\n  // @generated begin zorid-shell`)).toThrow('Incomplete');
  });
});

describe('downloaded app deep-link lifecycle integration', () => {
  test('persists cold and warm app routes while retaining Expo forwarding', () => {
    const patched = patchSceneDelegate(template);
    expect(patched).toContain('connectionOptions.urlContexts.forEach');
    expect(patched.indexOf('connectionOptions.urlContexts.forEach')).toBeLessThan(patched.indexOf('super.scene(scene, willConnectTo:'));
    expect(patched).toContain('override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>)');
    expect(patched).toContain('let unhandledContexts = Set(URLContexts.filter { !ZoridShellCoordinator.shared.handleURL($0.url) })');
    expect(patched).toContain('if !unhandledContexts.isEmpty');
    expect(patched).toContain('super.scene(scene, openURLContexts: unhandledContexts)');
    expect(patched).not.toContain('super.scene(scene, openURLContexts: URLContexts)');
  });
});
