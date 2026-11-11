import { expect, test } from 'bun:test';
import { createScreenTimeClient, parseScreenTimeStatus, screenTimeBlurStyles,
  type NativeScreenTime, type ScreenTimeShieldConfig, type ScreenTimeStatus } from './client';

const initialStatus: ScreenTimeStatus = { available: true, authorization: 'approved',
  policies: [{ id: 'focus', mode: 'blocklist', applicationCount: 2, categoryCount: 0 }], active: null,
  shieldCapabilities: { openApp: false, secondarySubmenu: false } };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=';
function native(overrides: Partial<NativeScreenTime> = {}): NativeScreenTime {
  return { async status() { return JSON.stringify(initialStatus); }, async requestAuthorization() {},
    async editPolicy() { return JSON.stringify(initialStatus); }, async deletePolicy() {}, async clear() {}, async apply() {}, ...overrides };
}
function config(): ScreenTimeShieldConfig {
  return { backgroundBlurStyle: 'systemMaterial', backgroundColor: { light: '#F7F6F2AA', dark: '#172320' },
    icon: { systemName: 'timer' }, title: { text: 'Focus in progress', color: '#203d38' },
    subtitle: { text: 'Pause or finish your session in Zorid.', color: '#65756F' },
    primaryButtonBackgroundColor: '#176B58', primaryButtonLabel: { text: 'Return to focus', color: '#FFFFFF' },
    secondaryButtonLabel: { text: 'Stay here', color: '#176B58' }, actions: { primary: 'close', secondary: 'none' } };
}

test('custom shield configuration requires a supporting installed bridge', async () => {
  const missing = createScreenTimeClient(null);
  expect(missing.shieldAvailable).toBe(false);
  await expect(missing.configureShield('productivity', 'focus', config())).rejects.toThrow('iPhone build');
  const older = createScreenTimeClient(native());
  expect(older.available).toBe(true);
  expect(older.shieldAvailable).toBe(false);
  await expect(older.configureShield('productivity', 'focus', config())).rejects.toThrow('custom Screen Time shields');
});

test('deployed shields serialize Apple configuration fields and can reset the policy appearance', async () => {
  const calls: { appId: string; policyId: string; value: unknown }[] = [];
  const client = createScreenTimeClient(native({ async configureShield(appId, policyId, json) {
    calls.push({ appId, policyId, value: json === null ? null : JSON.parse(json) });
  } }));
  expect(client.shieldAvailable).toBe(true);
  expect(await client.configureShield('productivity', 'focus', config())).toEqual(initialStatus);
  await client.configureShield('productivity', 'focus', null);
  expect(calls).toEqual([{ appId: 'productivity', policyId: 'focus', value: config() },
    { appId: 'productivity', policyId: 'focus', value: null }]);
});

test('Apple nullable fields and unrestricted label text preserve empty strings, whitespace, newlines and long text', async () => {
  const sent: unknown[] = [];
  const client = createScreenTimeClient(native({ async configureShield(_appId, _policyId, json) { sent.push(JSON.parse(json!)); } }));
  const empty: ScreenTimeShieldConfig = { backgroundBlurStyle: null, backgroundColor: null, icon: null, title: null,
    subtitle: null, primaryButtonLabel: null, primaryButtonBackgroundColor: null, secondaryButtonLabel: null,
    secondaryButtonSubmenuItems: null, actions: null };
  const text: ScreenTimeShieldConfig = { title: { text: ' \n\t  ', color: '#00000000' }, subtitle: { text: '🦔'.repeat(1000), color: '#FFFFFF' },
    primaryButtonLabel: { text: '', color: '#FFFFFF' } };
  await client.configureShield('productivity', 'focus', {});
  await client.configureShield('productivity', 'focus', empty);
  await client.configureShield('productivity', 'focus', text);
  expect(sent).toEqual([{}, empty, text]);
});

test('all twenty iOS blur styles and bounded PNG icons are available to deployed code', async () => {
  const sent: ScreenTimeShieldConfig[] = [];
  const client = createScreenTimeClient(native({ async configureShield(_appId, _policyId, json) { sent.push(JSON.parse(json!)); } }));
  expect(screenTimeBlurStyles).toHaveLength(20);
  for (const backgroundBlurStyle of screenTimeBlurStyles) await client.configureShield('productivity', 'focus', { backgroundBlurStyle });
  await client.configureShield('productivity', 'focus', { icon: { pngBase64: png } });
  expect(sent.map(item => item.backgroundBlurStyle).slice(0, 20)).toEqual([...screenTimeBlurStyles]);
  expect(sent.at(-1)).toEqual({ icon: { pngBase64: png } });
});

test('submenu items remain independent of the secondary label and preserve indexed native responses', async () => {
  const sent: unknown[] = [];
  const client = createScreenTimeClient(native({ async configureShield(_appId, _policyId, json) { sent.push(JSON.parse(json!)); } }));
  const submenu: ScreenTimeShieldConfig = { secondaryButtonSubmenuItems: ['Close', 'Refresh shield', 'Keep showing'],
    actions: { submenu: ['close', 'defer', 'stay'] } };
  const appearanceOnly: ScreenTimeShieldConfig = { secondaryButtonSubmenuItems: ['Keep showing'] };
  await client.configureShield('productivity', 'focus', submenu);
  await client.configureShield('productivity', 'focus', appearanceOnly);
  expect(sent).toEqual([submenu, appearanceOnly]);
});

test('malformed shield schemas, menus, images, colors and oversized transport never reach native', () => {
  let calls = 0;
  const client = createScreenTimeClient(native({ async configureShield() { calls++; } }));
  const oversizedDimensions = Buffer.from(png, 'base64'); oversizedDimensions.writeUInt32BE(1025, 16);
  const oversizedImage = Buffer.alloc(128 * 1024 + 1); Buffer.from(png, 'base64').copy(oversizedImage);
  const invalid: unknown[] = [undefined, [], { title: 'legacy string' }, { title: { text: null, color: '#000000' } },
    { title: { text: 'Missing color' } }, { backgroundColor: '#1234' }, { backgroundColor: { light: '#000000' } },
    { backgroundColor: { light: '#000000', dark: '#FFFFFF', alpha: 0.5 } }, { backgroundBlurStyle: 'extraDark' },
    { applicationTokens: ['not-allowed'] }, { layout: { arbitrary: 'view' } },
    { icon: 'timer' }, { icon: { systemName: 'timer', pngBase64: png } }, { icon: { pngBase64: 'not base64' } },
    { icon: { pngBase64: Buffer.from('not PNG').toString('base64') } },
    { icon: { pngBase64: oversizedDimensions.toString('base64') } }, { icon: { pngBase64: oversizedImage.toString('base64') } },
    { actions: { primary: 'execute' } }, { actions: { primary: 'close', javascript: 'alert(1)' } },
    { secondaryButtonSubmenuItems: [], actions: { submenu: [] } },
    { actions: { submenu: [] } }, { actions: { submenu: ['close'] } },
    { secondaryButtonSubmenuItems: ['A'], actions: { submenu: ['close', 'defer'] } },
    { secondaryButtonSubmenuItems: Array(1), actions: { submenu: ['close'] } },
    { secondaryButtonSubmenuItems: ['A'], actions: { submenu: Array(1) } },
    { secondaryButtonSubmenuItems: ['A', 'B', 'C', 'D'], actions: { submenu: ['close', 'close', 'close', 'close'] } },
    { title: { text: 'x'.repeat(256 * 1024), color: '#FFFFFF' } },
    { title: { text: '🦔'.repeat(70 * 1024), color: '#FFFFFF' } }];
  for (const value of invalid) expect(() => client.configureShield('productivity', 'focus', value as ScreenTimeShieldConfig)).toThrow();
  expect(() => client.configureShield('../app', 'focus', config())).toThrow();
  expect(() => client.configureShield('productivity', '../policy', config())).toThrow();
  expect(calls).toBe(0);
});

test('policy metadata reports existing custom shields without exposing native selection data', () => {
  const decoded = parseScreenTimeStatus(JSON.stringify({ ...initialStatus,
    policies: [{ ...initialStatus.policies[0], customShield: true, applicationTokens: ['private'] }] }));
  expect(decoded.policies[0]).toEqual({ ...initialStatus.policies[0], customShield: true });
  expect(() => parseScreenTimeStatus(JSON.stringify({ ...initialStatus,
    policies: [{ ...initialStatus.policies[0], customShield: 'yes' }] }))).toThrow('policy');
});

test('deployed editors can load validated current shield configuration or its native default', async () => {
  let saved: string | null = JSON.stringify(config());
  const client = createScreenTimeClient(native({ async getShield() { return saved; } }));
  expect(await client.getShield('productivity', 'focus')).toEqual(config());
  saved = null;
  expect(await client.getShield('productivity', 'focus')).toBeNull();
  saved = JSON.stringify({ ...config(), applicationTokens: ['private'] });
  await expect(client.getShield('productivity', 'focus')).rejects.toThrow('configuration');
  await expect(createScreenTimeClient(native()).getShield('productivity', 'focus')).rejects.toThrow('read custom');
});

test('queued shield configurations capture nested content before the caller changes it', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: unknown[] = [];
  const client = createScreenTimeClient(native({ async requestAuthorization() { await gate; },
    async configureShield(_appId, _policyId, json) { sent.push(JSON.parse(json!)); } }));
  const authorization = client.requestAuthorization('productivity');
  const appearance = config();
  const pending = client.configureShield('productivity', 'focus', appearance);
  appearance.title!.text = 'Changed'; appearance.actions!.primary = 'defer';
  (appearance.backgroundColor as { light: string; dark: string }).light = '#000000';
  release(); await authorization; await pending;
  expect(sent).toEqual([config()]);
});

test('OS feature availability is native-reported and unsupported operations do not poison later resets', async () => {
  const client = createScreenTimeClient(native({ async configureShield(_appId, _policyId, json) {
    const parsed = json === null ? null : JSON.parse(json);
    if (parsed?.actions?.primary === 'openApp') throw new Error('Opening Zorid requires iOS 26.5 or later.');
    if (parsed?.secondaryButtonSubmenuItems) throw new Error('Shield submenus require iOS 26.4 or later.');
  } }));
  expect((await client.status('productivity')).shieldCapabilities).toEqual({ openApp: false, secondarySubmenu: false });
  await expect(client.configureShield('productivity', 'focus', { actions: { primary: 'openApp' } })).rejects.toThrow('26.5');
  await expect(client.configureShield('productivity', 'focus', { secondaryButtonSubmenuItems: ['Close'], actions: { submenu: ['close'] } })).rejects.toThrow('26.4');
  expect(await client.configureShield('productivity', 'focus', null)).toEqual(initialStatus);
  const decoded = parseScreenTimeStatus(JSON.stringify({ ...initialStatus, shieldCapabilities: { openApp: true, secondarySubmenu: true, applicationTokens: ['private'] } }));
  expect(decoded.shieldCapabilities).toEqual({ openApp: true, secondarySubmenu: true });
  expect(() => parseScreenTimeStatus(JSON.stringify({ ...initialStatus, shieldCapabilities: { openApp: 'yes' } }))).toThrow('capabilities');
  expect(() => parseScreenTimeStatus(JSON.stringify({ ...initialStatus, shieldCapabilities: { openApp: true, secondarySubmenu: 'yes' } }))).toThrow('capabilities');
});
