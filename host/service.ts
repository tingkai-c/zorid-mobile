import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
type Asset = { hash: string; key: string; fileExtension: string; contentType: string; url: string };
type Manifest = { id: string; createdAt: string; runtimeVersion: string; launchAsset: Asset; assets: Asset[]; metadata: Record<string, string>; extra: object };
type Release = { id: string; runtime: string; platform: string; manifest: string };
export type HostConfig = { origin: string; name: string };

export class Host {
  readonly db: Database;
  constructor(readonly directory = process.env.ZORID_HOME ?? join(homedir(), '.local/share/zorid')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new Database(join(directory, 'host.sqlite'), { create: true });
    chmodSync(join(directory, 'host.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offers (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, runtime TEXT NOT NULL, platform TEXT NOT NULL, manifest TEXT NOT NULL);`);
  }
  get config(): HostConfig {
    const row = this.db.query('SELECT value FROM config WHERE id=1').get() as { value: string } | null;
    if (!row) throw new Error('Run init --url https://your-host first');
    return JSON.parse(row.value);
  }
  init(origin: string, name = 'Zorid host', loopback = false) {
    const url = new URL(origin);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw new Error('Use an HTTPS origin; HTTP requires --dev-loopback and a loopback host');
    }
    const existing = this.db.query('SELECT value FROM config WHERE id=1').get() as { value: string } | null;
    if (existing && JSON.parse(existing.value).origin !== url.origin) throw new Error('Host origin is pinned; use a separate state directory for another origin');
    const keyPath = join(this.directory, 'private-key.pem');
    if (!existsSync(keyPath)) {
      const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', keyPath, '-out', join(this.directory, 'certificate.pem'), '-days', '3650', '-subj', '/CN=Zorid local updates', '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=codeSigning', '-addext', 'basicConstraints=critical,CA:FALSE'], { stdio: 'pipe' });
      if (result.status !== 0) throw new Error('Could not generate signing certificate with openssl');
      chmodSync(keyPath, 0o600);
    }
    this.db.query('INSERT OR REPLACE INTO config VALUES (1, ?)').run(JSON.stringify({ origin: url.origin, name }));
    return { ...this.config, certificate: join(this.directory, 'certificate.pem') };
  }
  pair(ttlMs = 300_000) {
    const token = secret();
    const expiresAt = Date.now() + ttlMs;
    this.db.query('DELETE FROM offers WHERE expires < ?').run(Date.now());
    this.db.query('INSERT INTO offers VALUES (?, ?)').run(digest(token), expiresAt);
    return { uri: `zorid://pair?url=${encodeURIComponent(this.config.origin)}&token=${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }
  redeem(token: string, deviceName: string) {
    return this.db.transaction(() => {
      const offer = this.db.query('DELETE FROM offers WHERE hash=? AND expires > ? RETURNING hash').get(digest(token), Date.now());
      if (!offer) return null;
      const deviceId = randomUUID();
      const credential = secret();
      this.db.query('INSERT INTO devices VALUES (?, ?, ?, ?)').run(deviceId, deviceName, digest(credential), new Date().toISOString());
      return { deviceId, token: credential, hostName: this.config.name, updateUrl: `${this.config.origin}/updates` };
    })();
  }
  devices() { return this.db.query('SELECT id, name, created FROM devices ORDER BY created').all(); }
  revoke(id: string) { return { revoked: this.db.query('DELETE FROM devices WHERE id=?').run(id).changes > 0 }; }
  status() { return { ...this.config, devices: this.devices(), releases: this.db.query('SELECT id, runtime, platform FROM releases ORDER BY seq DESC').all() }; }
  private contained(root: string, file: string) {
    if (typeof file !== 'string' || isAbsolute(file)) throw new Error('Export paths must be relative');
    const actual = realpathSync(resolve(root, file));
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Export path escapes its directory');
    return actual;
  }
  deploy(exportDirectory: string, runtime: string, platform = 'ios') {
    if (!runtime || !['ios', 'android'].includes(platform)) throw new Error('Explicit runtime and ios/android platform required');
    const root = realpathSync(exportDirectory);
    const metadata = JSON.parse(readFileSync(this.contained(root, 'metadata.json'), 'utf8'));
    const files = metadata.fileMetadata?.[platform];
    if (!files || !Array.isArray(files.assets)) throw new Error('Invalid Expo export metadata');
    const assetDir = join(this.directory, 'assets');
    mkdirSync(assetDir, { recursive: true, mode: 0o700 });
    const asset = (path: string, extension: string, launch = false): Asset => {
      if (!/^[a-zA-Z0-9]+$/.test(extension)) throw new Error('Invalid asset extension');
      const data = readFileSync(this.contained(root, path));
      const hash = digest(data);
      const destination = join(assetDir, hash);
      if (!existsSync(destination)) writeFileSync(destination, data, { mode: 0o600, flag: 'wx' });
      return { hash: createHash('sha256').update(data).digest('base64url'), key: createHash('md5').update(data).digest('hex'), fileExtension: `.${extension}`, contentType: launch ? 'application/javascript' : Bun.file(`asset.${extension}`).type || 'application/octet-stream', url: `${this.config.origin}/assets/${hash}` };
    };
    const manifest: Manifest = { id: randomUUID(), createdAt: this.nextTimestamp(), runtimeVersion: runtime, launchAsset: asset(files.bundle, 'bundle', true), assets: files.assets.map((a: { path: string; ext: string }) => asset(a.path, a.ext)), metadata: {}, extra: {} };
    const configFile = join(root, 'expoConfig.json');
    if (existsSync(configFile)) manifest.extra = { expoClient: JSON.parse(readFileSync(this.contained(root, 'expoConfig.json'), 'utf8')) };
    this.save(manifest, platform);
    return { id: manifest.id, runtime, platform, assets: manifest.assets.length };
  }
  private nextTimestamp() {
    const row = this.db.query('SELECT manifest FROM releases ORDER BY seq DESC LIMIT 1').get() as { manifest: string } | null;
    return new Date(Math.max(Date.now(), row ? Date.parse(JSON.parse(row.manifest).createdAt) + 1 : 0)).toISOString();
  }
  private save(manifest: Manifest, platform: string) {
    this.db.query('INSERT INTO releases (id,runtime,platform,manifest) VALUES (?,?,?,?)').run(manifest.id, manifest.runtimeVersion, platform, JSON.stringify(manifest));
  }
  rollback(id: string) {
    const row = this.db.query('SELECT * FROM releases WHERE id=?').get(id) as Release | null;
    if (!row) throw new Error('Unknown release');
    const manifest: Manifest = { ...JSON.parse(row.manifest), id: randomUUID(), createdAt: this.nextTimestamp() };
    this.save(manifest, row.platform);
    return { id: manifest.id, restoredRelease: id, runtime: row.runtime, platform: row.platform };
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    if (url.pathname === '/pair' && request.method === 'POST') {
      if (Number(request.headers.get('content-length') ?? 0) > 4096) return json({ error: 'Body too large' }, 413);
      // Bound streamed bodies too; do not buffer an untrusted unlimited request.
      const reader = request.body?.getReader();
      if (!reader) return json({ error: 'Missing body' }, 400);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); return json({ error: 'Body too large' }, 413); } chunks.push(value); }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof body.token !== 'string' || body.token.length > 128 || typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.length > 100) return json({ error: 'Invalid pairing request' }, 400);
        const result = this.redeem(body.token, body.deviceName.trim());
        return result ? json(result) : json({ error: 'Pairing offer expired or already used' }, 401);
      } catch { return json({ error: 'Invalid pairing request' }, 400); }
    }
    const authorization = request.headers.get('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || !this.db.query('SELECT id FROM devices WHERE hash=?').get(digest(token))) return json({ error: 'Unauthorized' }, 401);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    if (url.pathname === '/status') return json({ hostName: this.config.name, connected: true });
    if (/^\/assets\/[a-f0-9]{64}$/.test(url.pathname)) {
      const file = Bun.file(join(this.directory, 'assets', basename(url.pathname)));
      return await file.exists() ? new Response(file, { headers: { 'cache-control': 'private, max-age=31536000, immutable' } }) : json({ error: 'Not found' }, 404);
    }
    if (url.pathname !== '/updates') return json({ error: 'Not found' }, 404);
    const runtime = request.headers.get('expo-runtime-version');
    const platform = request.headers.get('expo-platform');
    const protocol = request.headers.get('expo-protocol-version');
    if (!runtime || !['ios', 'android'].includes(platform ?? '') || (protocol !== null && protocol !== '1')) return json({ error: 'Unsupported update request' }, 400);
    const accept = request.headers.get('accept') ?? '*/*';
    const acceptsMultipart = accept.split(',').some(entry => {
      const [media, ...parameters] = entry.trim().split(';');
      const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
      return ['multipart/mixed', '*/*'].includes(media!.trim()) && (!quality || Number(quality.trim().slice(2)) > 0);
    });
    if (!acceptsMultipart) return json({ error: 'Authenticated assets require multipart/mixed' }, 406);
    const expectedSignature = request.headers.get('expo-expect-signature');
    if (expectedSignature) {
      const keyid = expectedSignature.match(/keyid="([^"]+)"/)?.[1];
      const algorithm = expectedSignature.match(/alg="([^"]+)"/)?.[1];
      if ((keyid && keyid !== 'main') || (algorithm && algorithm !== 'rsa-v1_5-sha256')) return json({ error: 'Unsupported signing key or algorithm' }, 400);
    }
    const headers = { 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'cache-control': 'private, no-store' };
    const row = this.db.query('SELECT * FROM releases WHERE runtime=? AND platform=? ORDER BY seq DESC LIMIT 1').get(runtime, platform!) as Release | null;
    if (!row || request.headers.get('expo-current-update-id') === row.id) return new Response(null, { status: 204, headers });
    const manifest: Manifest = JSON.parse(row.manifest);
    const signature = sign('RSA-SHA256', Buffer.from(row.manifest), readFileSync(join(this.directory, 'private-key.pem'))).toString('base64');
    const assetRequestHeaders = Object.fromEntries([manifest.launchAsset, ...manifest.assets].map(a => [a.key, { Authorization: `Bearer ${token}` }]));
    const boundary = `zorid-${randomUUID()}`;
    const body = `--${boundary}\r\ncontent-disposition: form-data; name="manifest"\r\ncontent-type: application/json\r\nexpo-signature: sig="${signature}", keyid="main"\r\n\r\n${row.manifest}\r\n--${boundary}\r\ncontent-disposition: form-data; name="extensions"\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ assetRequestHeaders })}\r\n--${boundary}--\r\n`;
    return new Response(body, { headers: { ...headers, 'content-type': `multipart/mixed; boundary=${boundary}` } });
  }
  close() { this.db.close(); }
}
