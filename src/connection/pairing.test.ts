import { describe, expect, test } from 'bun:test';
import { parsePairingLink, trustedOrigin, validatePairedHost } from './pairing';
const origin = 'https://my-host.example.ts.net';
const token = 'a'.repeat(43);
const link = (host = origin) => `zorid://pair?url=${encodeURIComponent(host)}&token=${token}`;
describe('pairing trust boundary', () => {
  test('accepts the configured HTTPS host and a bounded bearer token', () => {
    expect(parsePairingLink(link(), origin)).toEqual({ origin, token });
  });
  test('rejects other hosts, unsafe schemes, credentials, paths, and duplicate parameters', () => {
    for (const host of ['https://evil.example', 'http://my-host.example.ts.net', `${origin}/path`, 'https://user:pass@my-host.example.ts.net', `${origin}?x=1`]) {
      expect(() => parsePairingLink(link(host), origin)).toThrow();
    }
    expect(() => parsePairingLink(`${link()}&token=${token}`, origin)).toThrow();
    expect(() => parsePairingLink(link().replace('zorid:', 'https:'), origin)).toThrow();
    expect(() => parsePairingLink(`${link()}#ignored`, origin)).toThrow();
    expect(() => parsePairingLink(link().replace(token, 'short'), origin)).toThrow();
  });
  test('rejects unconfigured binaries', () => { expect(() => trustedOrigin(undefined)).toThrow(); });
  test('response cannot redirect update credentials to another origin or route', () => {
    const response = { deviceId: 'abc-123', token, hostName: 'My laptop', updateUrl: `${origin}/updates` };
    expect(validatePairedHost(response, origin)).toEqual(response);
    for (const updateUrl of ['https://evil.example/updates', `${origin}/other`, `${origin}/updates?token=x`]) {
      expect(() => validatePairedHost({ ...response, updateUrl }, origin)).toThrow();
    }
    expect(() => validatePairedHost({ ...response, token: '\r\nInjected' }, origin)).toThrow();
  });
});
