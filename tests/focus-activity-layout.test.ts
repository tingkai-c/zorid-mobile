import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { decodeActionTarget } from '../src/actions/codec';
import { changeFocus, startFocus } from '../src/domain/focus';
import { focusSessionPresentation } from '../src/native/focus-session';

// Exercise Expo's actual widget compiler and JS renderer, not a copied view tree.
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dir, '..');
const widgetsRoot = dirname(require.resolve('expo-widgets/package.json'));
const bundle = resolve(root, 'build/test-layout/ExpoWidgets.bundle');
type Modifier = { $type: string; color?: string; style?: string | { color?: string }; tint?: { color?: string }; width?: number };
type Node = { type: string; props: { modifiers?: Modifier[]; children?: unknown; timerInterval?: unknown; label?: string; target?: string } };
type Layout = Record<string, Node>;
let renderer: (colorScheme: 'light' | 'dark', status?: 'running' | 'paused', isStale?: boolean) => Layout;

function presentation(status: 'running' | 'paused') {
  const session = startFocus('layout-session', {
    id: 'layout-task', title: 'A long task title that must remain readable in limited space', completed: false, createdAt: 1_000,
  }, 1_000);
  return focusSessionPresentation(status === 'paused' ? changeFocus(session, 'pause', 151_000) : session, 151_000);
}

beforeAll(() => {
  const build = Bun.spawnSync(['node', resolve(widgetsRoot, 'scripts/build-bundle.mjs'), root, 'ios', bundle], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (build.exitCode !== 0) throw new Error(`Expo widget runtime compilation failed: ${build.stderr.toString()}`);
  const babel = require('@babel/core');
  const result = babel.transformSync(readFileSync(resolve(root, 'src/native/FocusActivity.tsx'), 'utf8'), {
    configFile: false, babelrc: false, filename: 'FocusActivity.tsx',
    presets: [[require.resolve('babel-preset-expo'), { jsxRuntime: 'automatic' }]],
    caller: { name: 'metro', platform: 'ios', isDev: false },
  });
  let serialized = '';
  runInContext(result.code, createContext({ exports: {}, require: (name: string) => name === 'expo-widgets'
    ? { createLiveActivity: (_name: string, source: string) => { serialized = source; } } : {} }));
  expect(serialized).not.toBe('');
  const context = createContext({ console, __DEV__: false });
  runInContext(readFileSync(bundle, 'utf8'), context);
  context.__expoWidgetLayout = runInContext(`(${serialized})`, context);
  renderer = (colorScheme, status = 'running', isStale = false) => context.__expoWidgetRender(
    presentation(status), { colorScheme, isStale, activityFamily: 'medium' });
}, 60_000);

function modifier(node: Node, type: string) { return node.props.modifiers?.find(item => item.$type === type); }
function styledNodes(value: unknown, inherited: Map<string, Modifier> = new Map()): { node: Node; styles: Map<string, Modifier> }[] {
  if (Array.isArray(value)) return value.flatMap(child => styledNodes(child, inherited));
  if (!value || typeof value !== 'object' || !('type' in value)) return [];
  const node = value as Node;
  const styles = new Map(inherited);
  for (const style of node.props.modifiers ?? []) styles.set(style.$type, style);
  return [{ node, styles }, ...styledNodes(node.props.children, styles)];
}
function color(modifier: Modifier | undefined): string | undefined {
  return modifier?.color ?? (typeof modifier?.style === 'object' ? modifier.style.color : undefined) ?? modifier?.tint?.color;
}
function luminance(hex: string) {
  const rgb = hex.replace('#', '').match(/.{2}/g)!.slice(0, 3).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

describe('rendered Focus Live Activity constraints', () => {
  for (const appearance of ['light', 'dark'] as const) {
    test(`${appearance}: banner pairs its foreground with an explicit readable background`, () => {
      const { banner } = renderer(appearance);
      const foreground = color(modifier(banner, 'foregroundStyle'));
      const background = color(modifier(banner, 'activityBackgroundTint'));
      expect(foreground, 'banner text needs a deterministic color').toBeDefined();
      expect(background, 'banner must not mix brand text with an uncontrolled background').toBeDefined();
      expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
    });
    test(`${appearance}: every Island region has readable foreground on its fixed black background`, () => {
      const layout = renderer(appearance);
      for (const [region, node] of Object.entries(layout).filter(([region]) => /^(compact|expanded|minimal)/.test(region))) {
        const foreground = color(modifier(node, 'foregroundStyle'));
        expect(foreground, `${region} cannot inherit the app's appearance on a black Island`).toBeDefined();
        expect(contrast(foreground!, '#000000')).toBeGreaterThanOrEqual(4.5);
      }
    });
    test(`${appearance}: compact countdown fits the narrow Island region`, () => {
      const timer = styledNodes(renderer(appearance).compactTrailing).find(({ node }) => node.props.timerInterval);
      expect(timer).toBeDefined();
      const width = timer!.styles.get('frame')?.width;
      expect(width, 'SwiftUI timerInterval text expands horizontally unless explicitly framed').toBeDefined();
      expect(width!).toBeGreaterThan(0);
      expect(width!).toBeLessThanOrEqual(52.33);
    });
  }
  test('controls have explicit button styling and tint rather than system-dependent defaults', () => {
    for (const status of ['running', 'paused'] as const) {
      const layout = renderer('light', status);
      const buttons = styledNodes(layout.banner).filter(({ node }) => node.type === 'Button');
      expect(buttons).toHaveLength(2);
      for (const button of buttons) {
        expect(button.styles.get('buttonStyle')).toBeDefined();
        expect(button.styles.get('tint')).toBeDefined();
      }
    }
  });
  test('primary button labels contrast with their solid tint in both appearances and presentations', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const status of ['running', 'paused'] as const) {
        const layout = renderer(appearance, status);
        for (const region of ['banner', 'expandedBottom']) {
          const primary = styledNodes(layout[region]).find(({ node, styles }) => node.type === 'Button'
            && styles.get('buttonStyle')?.style === 'borderedProminent');
          expect(primary, `${region} needs a primary Pause or Resume button`).toBeDefined();
          const foreground = color(primary!.styles.get('foregroundStyle'));
          const background = color(primary!.styles.get('tint'));
          expect(foreground).toBeDefined();
          expect(background).toBeDefined();
          expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
  test('serialized controls preserve the real versioned action targets for each session state', () => {
    for (const status of ['running', 'paused'] as const) {
      const props = presentation(status);
      const expected = [status === 'running' ? props.pauseTarget! : props.resumeTarget!, props.finishTarget!];
      const layout = renderer('light', status);
      for (const region of ['banner', 'expandedBottom']) {
        const targets = styledNodes(layout[region]).filter(({ node }) => node.type === 'Button').map(({ node }) => node.props.target);
        expect(targets).toEqual(expected);
        for (const target of targets) {
          expect(target!.startsWith('zorid-activity-action:')).toBe(true);
          expect(decodeActionTarget(target!).actionId).toBe('focus.control');
        }
      }
    }
  });
  test('stale running activities remove actionable controls from every rendered region', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const layout = renderer(appearance, 'running', true);
      for (const node of Object.values(layout)) {
        expect(styledNodes(node).filter(({ node }) => node.type === 'Button')).toHaveLength(0);
      }
      expect(styledNodes(layout.banner).some(({ node }) => node.props.timerInterval !== undefined)).toBe(false);
    }
  });
});
