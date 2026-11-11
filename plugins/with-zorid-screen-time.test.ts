import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { entitlements, configureProject, generateSources, patchWidgetEntitlements, extensions } = require('./with-zorid-screen-time.cjs');
const plist = require('@expo/plist').default;

function projectFixture() {
  const project = require('xcode').project('unused.pbxproj');
  project.hash = { project: { objects: {
    PBXProject: { PROJECT: { isa: 'PBXProject', mainGroup: 'MAIN', targets: [{ value: 'APP', comment: 'Zorid' }] } },
    PBXNativeTarget: { APP: { isa: 'PBXNativeTarget', name: 'Zorid', buildPhases: [], dependencies: [] } },
    PBXGroup: { MAIN: { isa: 'PBXGroup', children: [] }, PRODUCTS: { isa: 'PBXGroup', name: 'Products', children: [] } },
    XCBuildConfiguration: {}, XCConfigurationList: {}, PBXFileReference: {}, PBXBuildFile: {},
    PBXTargetDependency: {}, PBXContainerItemProxy: {},
  } } };
  return project;
}

describe('Screen Time native installation', () => {
  test('preserves app capabilities and adds Family Controls once', () => {
    const input = { 'aps-environment': 'development', 'com.apple.security.application-groups': ['other'] };
    const result = entitlements(input);
    expect(result['aps-environment']).toBe('development');
    expect(result['com.apple.security.application-groups']).toEqual(['other', 'group.app.zorid.mobile']);
    expect(result['com.apple.developer.family-controls']).toBe(true);
    expect(entitlements(result)).toEqual(result);
  });
  test('creates three embedded extensions with unique sources and app-matching versions', () => {
    const project = projectFixture();
    const config = { version: '0.1.0', ios: { buildNumber: '23' } };
    configureProject(project, config);
    const first = project.writeSync();
    configureProject(project, config);
    expect(project.writeSync()).toBe(first);
    const targets = project.pbxNativeTargetSection();
    const sourceReferences = new Set<string>();
    for (const extension of extensions) {
      const entry = Object.entries(targets).find(([, target]) =>
        typeof target === 'object' && target !== null && (target as { name: string }).name === `"${extension.name}"`);
      expect(entry).toBeDefined();
      const target = entry![1] as { buildConfigurationList: string; productReference: string; buildPhases: { value: string; comment: string }[] };
      const configs = project.pbxXCConfigurationList()[target.buildConfigurationList].buildConfigurations;
      for (const item of configs) {
        const settings = project.pbxXCBuildConfigurationSection()[item.value].buildSettings;
        expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe(extension.bundle);
        expect(settings.CURRENT_PROJECT_VERSION).toBe('23');
        expect(settings.APPLICATION_EXTENSION_API_ONLY).toBe('YES');
        expect(settings.CODE_SIGN_ENTITLEMENTS).toBe(`${extension.name}/${extension.name}.entitlements`);
      }
      expect(target.buildPhases.map(phase => phase.comment)).toContain('Sources');
      const sourcesPhase = target.buildPhases.find(phase => phase.comment === 'Sources')!;
      const sources = project.hash.project.objects.PBXSourcesBuildPhase[sourcesPhase.value].files as { value: string }[];
      const group = Object.values(project.hash.project.objects.PBXGroup).find(group =>
        typeof group === 'object' && group !== null && (group as { name: string }).name === extension.name) as { children: { value: string }[]; path?: string };
      expect(group.path).toBeUndefined();
      expect(sources).toHaveLength(4);
      for (const file of sources) {
        const reference = project.pbxBuildFileSection()[file.value].fileRef;
        expect(group.children.some(child => child.value === reference)).toBe(true);
        expect(project.pbxFileReferenceSection()[reference].path).toContain(`${extension.name}/`);
        expect(sourceReferences.has(reference)).toBe(false);
        sourceReferences.add(reference);
      }
      const dependencies = Object.values(project.hash.project.objects.PBXTargetDependency) as { target?: string }[];
      expect(dependencies.some(dependency => dependency.target === entry![0])).toBe(true);
      const copies = Object.values(project.hash.project.objects.PBXCopyFilesBuildPhase) as { files?: { value: string }[] }[];
      const buildFiles = project.pbxBuildFileSection();
      expect(copies.some(copy => copy.files?.some(file => buildFiles[file.value]?.fileRef === target.productReference))).toBe(true);
    }
  });
  test('upgrades earlier monitor-relative references without duplicating source membership', () => {
    const project = projectFixture();
    configureProject(project, {});
    const groups = project.hash.project.objects.PBXGroup;
    const group = Object.values(groups).find(value => value && typeof value === 'object'
      && (value as { name?: string }).name === 'ZoridFocusMonitor') as { path?: string };
    group.path = 'ZoridFocusMonitor';
    for (const reference of Object.values(project.pbxFileReferenceSection())) {
      if (reference && typeof reference === 'object' && typeof (reference as { path?: unknown }).path === 'string') {
        const file = reference as { path: string };
        file.path = file.path.replace('ZoridFocusMonitor/', '');
      }
    }
    configureProject(project, {});
    expect(group.path).toBeUndefined();
    const first = project.writeSync();
    configureProject(project, {});
    expect(project.writeSync()).toBe(first);
    const target = project.pbxTargetByName('"ZoridFocusMonitor"');
    const phase = target.buildPhases.find((value: { comment: string }) => value.comment === 'Sources');
    const files = project.hash.project.objects.PBXSourcesBuildPhase[phase.value].files;
    expect(files).toHaveLength(4);
    for (const file of files) {
      const reference = project.pbxBuildFileSection()[file.value].fileRef;
      expect(project.pbxFileReferenceSection()[reference].path).toContain('ZoridFocusMonitor/');
    }
  });
  test('generates extension metadata and shared sources without opaque selections', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zorid-screen-time-'));
    try {
      await mkdir(path.join(root, 'ExpoWidgetsTarget'));
      await writeFile(path.join(root, 'ExpoWidgetsTarget/ExpoWidgetsTarget.entitlements'), plist.build({ existing: true }));
      await generateSources(path.resolve(import.meta.dir, '..'), root);
      await patchWidgetEntitlements(root);
      for (const extension of extensions) {
        const directory = path.join(root, extension.name);
        expect(await readFile(path.join(directory, 'ZoridScreenTimeController.swift'), 'utf8'))
          .toBe(await readFile(path.resolve(import.meta.dir, '../modules/zorid-screen-time/ios/ZoridScreenTimeController.swift'), 'utf8'));
        expect(await readFile(path.join(directory, `${extension.name}.swift`), 'utf8')).toContain(`class ${extension.name}`);
        const info = plist.parse(await readFile(path.join(directory, 'Info.plist'), 'utf8'));
        expect(info.NSExtension.NSExtensionPointIdentifier).toBe(extension.point);
        expect(info.NSExtension.NSExtensionPrincipalClass).toBe(`$(PRODUCT_MODULE_NAME).${extension.name}`);
        const targetEntitlements = plist.parse(await readFile(path.join(directory, `${extension.name}.entitlements`), 'utf8'));
        expect(targetEntitlements['com.apple.security.application-groups']).toEqual(['group.app.zorid.mobile']);
        expect(targetEntitlements['com.apple.developer.family-controls']).toBe(true);
      }
      const widgets = plist.parse(await readFile(path.join(root, 'ExpoWidgetsTarget/ExpoWidgetsTarget.entitlements'), 'utf8'));
      expect(widgets.existing).toBe(true);
      expect(widgets['com.apple.developer.family-controls']).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
