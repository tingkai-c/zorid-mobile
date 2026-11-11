import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { patchPodspec, patchAppIntents, patchWidgetButtons, patchWidgetsModule } = createRequire(import.meta.url)('./with-zorid-actions.cjs') as {
  patchPodspec(source: string): string;
  patchAppIntents(source: string): string;
  patchWidgetButtons(source: string): string;
  patchWidgetsModule(source: string): string;
};
const source = (file: string) => readFileSync(new URL(`../node_modules/expo-widgets/ios/${file}`, import.meta.url), 'utf8');

// Run against the actual installed native sources: an upstream dependency change
// must invalidate these hooks instead of silently disabling durable actions.
describe('downloaded native action integration', () => {
  test('installs the core dependency once and preserves unrelated pod settings', () => {
    const original = source('ExpoWidgets.podspec');
    const patched = patchPodspec(original);
    expect(patched).toContain("s.dependency 'ZoridActions'");
    expect(patched).toContain('# @generated begin zorid-actions-dependency');
    expect(patched).not.toContain('// @generated');
    expect(patched).toContain("s.dependency 'ExpoUI'");
    expect(patched).toContain('Build ExpoWidgets Bundle');
    expect(patchPodspec(patched)).toBe(patched);
    expect(patched.match(/s\.dependency 'ZoridActions'/g)).toHaveLength(1);
  });

  test('dispatches durable targets before Expo handlers and keeps intent process semantics', () => {
    const patched = patchAppIntents(source('Widgets/AppIntent.swift'));
    expect(patched).toContain('struct WidgetUserInteraction: AppIntent');
    expect(patched).toContain('struct LiveActivityUserInteraction: LiveActivityIntent');
    expect(patched.match(/try await ZoridActionSurfaces\.shared\.perform\(target: target\)/g)).toHaveLength(2);
    const widget = patched.slice(patched.indexOf('struct WidgetUserInteraction'), patched.indexOf('struct LiveActivityUserInteraction'));
    expect(widget.indexOf('ZoridActionSurfaces.shared.perform')).toBeLessThan(widget.indexOf('guard let source'));
    expect(widget).toContain('evaluateWidgetButtonPress');
    const activity = patched.slice(patched.indexOf('struct LiveActivityUserInteraction'));
    expect(activity.indexOf('ZoridActionSurfaces.shared.perform')).toBeLessThan(activity.indexOf('WidgetsEvents.shared.sendNotification'));
    expect(patchAppIntents(patched)).toBe(patched);
  });

  test('uses the app process only for explicitly activity-capable widget actions', () => {
    const original = source('Widgets/Buttons.swift');
    const patched = patchWidgetButtons(original);
    expect(patched).toContain('props.target?.hasPrefix("zorid-activity-action:") == true');
    expect(patched).toContain('intent: LiveActivityUserInteraction(source: props.source, target: props.target)');
    expect(patched).toContain('intent: WidgetUserInteraction(');
    expect(patched).toContain('entryIndex: props.entryIndex, environmentString: props.environmentString');
    expect(patched).toContain('@ViewBuilder private var actionLabel: some View');
    expect(patched).toContain('Children()');
    const ordinaryActivity = original.slice(original.indexOf('struct LiveActivityButtonView'));
    expect(patched.slice(patched.indexOf('struct LiveActivityButtonView'))).toBe(ordinaryActivity);
    expect(patchWidgetButtons(patched)).toBe(patched);
  });

  test('exposes pending effect recovery without changing existing widget APIs', () => {
    const patched = patchWidgetsModule(source('WidgetsModule.swift'));
    expect(patched).toContain('AsyncFunction("flushZoridActionEffects")');
    expect(patched).toContain('try await ZoridActionSurfaces.shared.flush(appId: appId)');
    expect(patched).toContain('Function("reloadAllWidgets")');
    expect(patched).toContain('Class("LiveActivity", LiveActivity.self)');
    expect(patchWidgetsModule(patched)).toBe(patched);
  });

  test('rejects changed anchors or damaged generated sections', () => {
    expect(() => patchPodspec("s.dependency 'OtherUI'" )).toThrow('Unsupported');
    expect(() => patchAppIntents(source('Widgets/AppIntent.swift').replace('WidgetUserInteraction: AppIntent', 'WidgetUserInteraction: OtherIntent'))).toThrow('Unsupported');
    expect(() => patchWidgetsModule('Name("OtherWidgets")')).toThrow('Unsupported');
    expect(() => patchWidgetButtons('struct UnknownView {}')).toThrow('Unsupported');
    expect(() => patchWidgetButtons(patchWidgetButtons(source('Widgets/Buttons.swift')).replace('// @generated end zorid-actions-widget-activity-button', ''))).toThrow('Incomplete');
    expect(() => patchWidgetsModule('Name("ExpoWidgets")\n// @generated begin zorid-actions-flush')).toThrow('Incomplete');
  });
});
