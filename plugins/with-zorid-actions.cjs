const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

// These hooks intentionally depend on Expo Widgets internals. Reject an upgrade until
// its native intent/storage implementation has been reviewed and the tests updated.
const supportedVersion = '58.0.27';
const marker = 'zorid-actions';

function insertBlock(source, anchor, name, content, comment = '//') {
  const begin = `${comment} @generated begin ${marker}-${name}`;
  const end = `${comment} @generated end ${marker}-${name}`;
  const first = source.indexOf(begin);
  const last = source.indexOf(end);
  if ((first >= 0) !== (last >= 0) || (first >= 0 && last < first)) {
    throw new Error(`Incomplete Zorid action patch: ${name}`);
  }
  const block = `${begin}\n${content}\n    ${end}`;
  if (first >= 0) return source.slice(0, first) + block + source.slice(last + end.length);
  if (source.split(anchor).length !== 2) throw new Error(`Unsupported Expo Widgets template: ${name}`);
  return source.replace(anchor, `${anchor}\n    ${block}`);
}

function patchPodspec(source) {
  return insertBlock(source, "  s.dependency 'ExpoUI'", 'dependency', "  s.dependency 'ZoridActions'", '#');
}

function patchIntent(source, declaration, name) {
  const first = source.indexOf(declaration);
  if (first < 0 || source.indexOf(declaration, first + declaration.length) >= 0) {
    throw new Error(`Unsupported Expo Widgets template: ${name}`);
  }
  const nextStruct = source.indexOf('\nstruct ', first + declaration.length);
  const end = nextStruct < 0 ? source.length : nextStruct;
  const part = source.slice(first, end);
  const patched = insertBlock(part, '  func perform() async throws -> some IntentResult {', name,
    '    if try await ZoridActionSurfaces.shared.perform(target: target) {\n      return .result()\n    }');
  return source.slice(0, first) + patched + source.slice(end);
}

function patchAppIntents(source) {
  source = patchIntent(source, 'struct WidgetUserInteraction: AppIntent {', 'widget-intent');
  return patchIntent(source, 'struct LiveActivityUserInteraction: LiveActivityIntent {', 'activity-intent');
}

function patchWidgetButtons(source) {
  const declaration = 'struct WidgetButtonView: ExpoSwiftUI.View {';
  const first = source.indexOf(declaration);
  const next = source.indexOf('\n@available(iOS 17.0, *)\nstruct LiveActivityButtonView:', first);
  if (first < 0 || next < first || source.indexOf(declaration, first + declaration.length) >= 0) {
    throw new Error('Unsupported Expo Widgets template: widget-activity-button');
  }
  const part = source.slice(first, next);
  const begin = '// @generated begin zorid-actions-widget-activity-button';
  const end = '// @generated end zorid-actions-widget-activity-button';
  if (part.includes(begin) !== part.includes(end)) throw new Error('Incomplete Zorid action patch: widget-activity-button');
  if (!part.includes(begin) && (!part.includes('intent: WidgetUserInteraction(') ||
      !part.includes('environmentString: props.environmentString') || !part.includes('Children()'))) {
    throw new Error('Unsupported Expo Widgets template: widget-activity-button');
  }
  const generated = `${declaration}
  ${begin}
  @ObservedObject var props: ButtonProps

  @ViewBuilder var body: some View {
    if props.target?.hasPrefix("zorid-activity-action:") == true {
      SwiftUI.Button(
        role: props.role?.toNativeRole(),
        intent: LiveActivityUserInteraction(source: props.source, target: props.target)
      ) { actionLabel }
    } else {
      SwiftUI.Button(
        role: props.role?.toNativeRole(),
        intent: WidgetUserInteraction(
          source: props.source, target: props.target,
          entryIndex: props.entryIndex, environmentString: props.environmentString
        )
      ) { actionLabel }
    }
  }

  @ViewBuilder private var actionLabel: some View {
    if let label = props.label {
      if let systemImage = props.systemImage {
        Label(title: { Text(label) }, icon: { Image(systemName: systemImage) })
      } else {
        Text(label)
      }
    } else {
      Children()
    }
  }
  ${end}
}
`;
  return source.slice(0, first) + generated + source.slice(next);
}

function patchWidgetsModule(source) {
  return insertBlock(source, '    Name("ExpoWidgets")', 'flush',
    '    AsyncFunction("flushZoridActionEffects") { (appId: String) async throws -> Int in\n      try await ZoridActionSurfaces.shared.flush(appId: appId)\n    }');
}

async function patchExpoWidgets(projectRoot) {
  const widgetsRoot = path.dirname(require.resolve('expo-widgets/package.json', { paths: [projectRoot] }));
  const metadata = JSON.parse(await fs.readFile(path.join(widgetsRoot, 'package.json'), 'utf8'));
  if (metadata.version !== supportedVersion) {
    throw new Error(`Zorid actions require reviewed Expo Widgets ${supportedVersion}; found ${metadata.version}.`);
  }
  const patches = [
    ['ios/ExpoWidgets.podspec', patchPodspec],
    ['ios/Widgets/AppIntent.swift', patchAppIntents],
    ['ios/Widgets/Buttons.swift', patchWidgetButtons],
    ['ios/WidgetsModule.swift', patchWidgetsModule],
  ];
  // Validate all anchors before writing any changes.
  const outputs = await Promise.all(patches.map(async ([file, patch]) => {
    const destination = path.join(widgetsRoot, file);
    return [destination, patch(await fs.readFile(destination, 'utf8'))];
  }));
  const adapter = await fs.readFile(path.join(projectRoot, 'native/actions/ZoridActionSurfaces.swift'), 'utf8');
  for (const [destination, output] of outputs) await fs.writeFile(destination, output);
  await fs.writeFile(path.join(widgetsRoot, 'ios/Widgets/ZoridActionSurfaces.swift'), adapter);
}

function withZoridActions(config) {
  return withDangerousMod(config, ['ios', async (mod) => {
    await patchExpoWidgets(mod.modRequest.projectRoot);
    return mod;
  }]);
}

module.exports = withZoridActions;
module.exports.patchPodspec = patchPodspec;
module.exports.patchAppIntents = patchAppIntents;
module.exports.patchWidgetButtons = patchWidgetButtons;
module.exports.patchWidgetsModule = patchWidgetsModule;
module.exports.patchExpoWidgets = patchExpoWidgets;
