import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from 'node:crypto';
import { Host } from './service';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'zorid-host-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const host = new Host(join(directory, 'private'));
  cleanup.push(() => host.close());
  host.init('https://host.example');
  const exportPath = join(directory, 'export'); mkdirSync(exportPath);
  writeFileSync(join(exportPath, 'app.js'), 'console.log("release")');
  writeFileSync(join(exportPath, 'asset.png'), 'image');
  writeFileSync(join(exportPath, 'metadata.json'), JSON.stringify({ fileMetadata: { ios: { bundle: 'app.js', assets: [{ path: 'asset.png', ext: 'png' }] } } }));
  return { host, directory, exportPath };
}
function offerToken(host: Host, ttl?: number) { return new URL(host.pair(ttl).uri).searchParams.get('token')!; }
function pair(host: Host) { return host.redeem(offerToken(host), 'Test iPhone')!; }
function request(path: string, token?: string, runtime = '1') {
  return new Request(`https://host.example${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'expo-platform': 'ios', 'expo-runtime-version': runtime, 'expo-protocol-version': '1', accept: 'multipart/mixed' } });
}
describe('paired update host', () => {
  test('pair tokens expire and are single use, only hashes persisted, revoke invalidates auth', async () => {
    const { host } = fixture();
    expect(host.redeem(offerToken(host, -1), 'expired')).toBeNull();
    const token = offerToken(host);
    const response = await host.handle(new Request('https://host.example/pair', { method: 'POST', body: JSON.stringify({ token, deviceName: 'Phone' }) }));
    expect(response.status).toBe(200);
    const device = await response.json();
    expect(host.redeem(token, 'replay')).toBeNull();
    expect(JSON.stringify(host.db.query('SELECT * FROM devices').all())).not.toContain(device.token);
    expect((await host.handle(request('/status', device.token))).status).toBe(200);
    host.revoke(device.deviceId);
    expect((await host.handle(request('/status', device.token))).status).toBe(401);
  });
  test('unsigned, incompatible and invalid path requests cannot receive releases', async () => {
    const { host, exportPath } = fixture();
    host.deploy(exportPath, '1'); const device = pair(host);
    expect((await host.handle(request('/updates'))).status).toBe(401);
    expect((await host.handle(request('/updates', device.token, 'different'))).status).toBe(204);
    expect((await host.handle(request('/assets/private-key.pem', device.token))).status).toBe(404);
  });
  test('signed manifest and asset headers work; immutable assets survive source edits; rollback is newer', async () => {
    const { host, exportPath } = fixture();
    const release = host.deploy(exportPath, '1'); const device = pair(host);
    writeFileSync(join(exportPath, 'app.js'), 'changed');
    const response = await host.handle(request('/updates', device.token));
    expect(response.status).toBe(200);
    const text = await response.text();
    const parts = text.split(/\r\n\r\n/);
    const manifestText = parts[1]!.split('\r\n--')[0]!;
    const manifest = JSON.parse(manifestText);
    const signature = text.match(/expo-signature: sig="([^"]+)"/)![1]!;
    expect(verify('RSA-SHA256', Buffer.from(manifestText), readFileSync(join(host.directory, 'certificate.pem')), Buffer.from(signature, 'base64'))).toBe(true);
    const extensions = JSON.parse(parts[2]!.split('\r\n--')[0]!);
    expect(extensions.assetRequestHeaders[manifest.launchAsset.key].Authorization).toBe(`Bearer ${device.token}`);
    const assetPath = new URL(manifest.launchAsset.url).pathname;
    expect((await host.handle(request(assetPath))).status).toBe(401);
    expect(await (await host.handle(request(assetPath, device.token))).text()).toBe('console.log("release")');
    const rolled = host.rollback(release.id);
    expect(rolled.id).not.toBe(release.id);
    const newer = host.db.query('SELECT manifest FROM releases WHERE id=?').get(rolled.id) as { manifest: string };
    expect(Date.parse(JSON.parse(newer.manifest).createdAt)).toBeGreaterThan(Date.parse(manifest.createdAt));
  });
  test('export traversal and symlink escapes rejected', () => {
    const { host, exportPath, directory } = fixture();
    writeFileSync(join(directory, 'outside.js'), 'secret');
    const metadata = (bundle: string) => writeFileSync(join(exportPath, 'metadata.json'), JSON.stringify({ fileMetadata: { ios: { bundle, assets: [] } } }));
    metadata('../outside.js'); expect(() => host.deploy(exportPath, '1')).toThrow('escapes');
    symlinkSync(join(directory, 'outside.js'), join(exportPath, 'link.js'));
    metadata('link.js'); expect(() => host.deploy(exportPath, '1')).toThrow('escapes');
  });
  test('HTTPS and immutable origin enforced', () => {
    const { host } = fixture();
    expect(() => host.init('http://remote.example')).toThrow('HTTPS');
    expect(() => host.init('https://other.example')).toThrow('pinned');
    expect(() => host.init('https://host.example/path')).toThrow('HTTPS');
  });
});
