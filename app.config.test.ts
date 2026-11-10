import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { ExpoConfig } from 'expo/config';

function configuredBuild(enabled: boolean): ExpoConfig {
  const env = { ...process.env };
  delete env.ZORID_UPDATE_URL;
  delete env.ZORID_UPDATE_CERTIFICATE;
  if (enabled) {
    env.ZORID_UPDATE_URL = 'https://host.example.ts.net/updates';
    env.ZORID_UPDATE_CERTIFICATE = '/tmp/zorid-public-certificate.pem';
  }
  const result = spawnSync(process.execPath, ['-e', 'import config from "./app.config.ts"; console.log(JSON.stringify(config))'], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

test('paired builds declare the header that the native updater must override', () => {
  const config = configuredBuild(true);
  expect(config.updates?.requestHeaders?.Authorization).toBe('Bearer unpaired');
  expect(config.updates?.disableAntiBrickingMeasures).not.toBe(true);
  expect(config.extra?.updateOrigin).toBe('https://host.example.ts.net');
});

test('local builds remain usable without an update host', () => {
  expect(configuredBuild(false).updates?.enabled).toBe(false);
});
