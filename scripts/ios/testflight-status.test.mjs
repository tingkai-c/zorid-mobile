import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkTestFlightStatus, runStatus, validateBuildNumber } from './testflight-status.mjs';

const app = { type: 'apps', id: '123456', attributes: { bundleId: 'app.zorid.mobile' } };
const build = { type: 'builds', id: 'synthetic-build', attributes: {
  version: '21', processingState: 'VALID', buildAudienceType: 'INTERNAL_ONLY',
} };
const detail = { type: 'buildBetaDetails', id: 'private-detail', attributes: { internalBuildState: 'IN_BETA_TESTING' } };
const group = { type: 'betaGroups', id: 'private-group', attributes: { isInternalGroup: true, name: 'PRIVATE_GROUP_NAME' } };
const expected = { buildNumber: '21', checkState: 'FOUND', processingState: 'VALID',
  buildAudienceType: 'INTERNAL_ONLY', internalBuildState: 'IN_BETA_TESTING', internalGroupAssigned: true,
  uploadState: 'UNKNOWN', failedEndpoint: null, httpStatus: null };
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const env = { BUILD_NUMBER: '21', ASC_API_KEY_ID: 'synthetic-key-id', ASC_API_ISSUER_ID: 'synthetic-issuer',
  ASC_API_KEY_P8_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };

function responses(payloads, inspect = () => {}) {
  let index = 0;
  return async (url, options) => {
    inspect(new URL(url), options, index);
    assert.ok(index < payloads.length, 'unexpected API request');
    return new Response(JSON.stringify(payloads[index++]), { status: 200 });
  };
}

test('uses the known app/build queries and checks actual internal-group membership', async () => {
  const fetchImpl = responses([{ data: [app] }, { data: [build] }, { data: detail }, { data: [group] }, { data: [build] }], (url, options, index) => {
    assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    assert.ok(options.signal);
    if (index === 0) assert.deepEqual([...url.searchParams], [['filter[bundleId]', 'app.zorid.mobile']]);
    if (index === 1) {
      assert.deepEqual([...url.searchParams], [['filter[app]', app.id], ['filter[version]', '21'], ['limit', '3']]);
    }
    if (index === 2) {
      assert.equal(url.pathname, `/v1/builds/${build.id}/buildBetaDetail`);
      assert.equal(url.search, '');
    }
    if (index === 3) {
      assert.equal(url.pathname, `/v1/apps/${app.id}/betaGroups`);
      assert.equal(url.search, '');
    }
    if (index === 4) {
      assert.equal(url.pathname, `/v1/betaGroups/${group.id}/builds`);
      assert.equal(url.search, '');
    }
  });
  assert.deepEqual(await checkTestFlightStatus({ buildNumber: '21', token: 'synthetic-token', fetchImpl }), expected);
});

test('reports pending processing and no assigned internal group without claiming distribution', async () => {
  const pending = { ...build, attributes: { ...build.attributes, processingState: 'PROCESSING' } };
  const result = await checkTestFlightStatus({ buildNumber: '21', token: 'synthetic', fetchImpl: responses([
    { data: [app] }, { data: [pending] }, { data: { ...detail, attributes: { internalBuildState: 'PROCESSING' } } },
    { data: [group] }, { data: [] },
  ]) });
  assert.deepEqual(result, { ...expected, processingState: 'PROCESSING', internalBuildState: 'PROCESSING', internalGroupAssigned: false });
});

test('unknown provider states and personal response fields cannot enter the receipt', async () => {
  const result = await checkTestFlightStatus({ buildNumber: '21', token: 'synthetic', fetchImpl: responses([
    { data: [app] }, { data: [{ ...build, attributes: { version: '21', processingState: 'PRIVATE_TOKEN', buildAudienceType: 'PRIVATE_TOKEN' } }] },
    { data: { ...detail, attributes: { internalBuildState: 'PRIVATE_TOKEN' } } }, { data: [group] }, { data: [build] },
  ]) });
  assert.deepEqual(result, { ...expected, processingState: 'UNKNOWN', buildAudienceType: 'UNKNOWN', internalBuildState: 'UNKNOWN' });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes(build.id));
});

test('a build absent from both listings stays unknown and makes no relationship queries', async () => {
  const result = await checkTestFlightStatus({ buildNumber: '21', token: 'synthetic', fetchImpl: responses([
    { data: [app] }, { data: [] }, { data: [] },
  ]) });
  assert.deepEqual(result, { ...expected, checkState: 'BUILD_NOT_FOUND', processingState: 'UNKNOWN',
    buildAudienceType: 'UNKNOWN', internalBuildState: 'UNKNOWN', internalGroupAssigned: false });
});

test('missing builds use the documented nested upload state without exposing provider diagnostics', async () => {
  for (const uploadState of ['AWAITING_UPLOAD', 'PROCESSING', 'COMPLETE', 'FAILED']) {
    const result = await runStatus(env, responses([
      { data: [app] }, { data: [] },
      { data: [{ type: 'buildUploads', id: 'PRIVATE_UPLOAD_ID', attributes: { cfBundleVersion: '21',
        state: { state: uploadState, errors: [{ detail: 'PRIVATE_PROVIDER_ERROR' }], warnings: ['PRIVATE_WARNING'], infos: ['PRIVATE_INFO'] } } }] },
    ], (url, options, index) => {
      if (index === 2) {
        assert.equal(url.pathname, `/v1/apps/${app.id}/buildUploads`);
        assert.deepEqual([...url.searchParams], [['filter[cfBundleVersion]', '21'], ['limit', '3']]);
      }
    }));
    assert.equal(result.receipt.uploadState, uploadState);
    assert.equal(result.receipt.checkState, uploadState === 'FAILED' ? 'UPLOAD_FAILED' : 'BUILD_NOT_FOUND');
    assert.equal(result.exitCode, uploadState === 'FAILED' ? 1 : 0);
    assert.equal(result.receipt.processingState, 'UNKNOWN');
    assert.equal(result.receipt.internalGroupAssigned, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('unknown or incorrectly flattened upload states never become provider-controlled receipt values', async () => {
  for (const state of [{ state: 'PRIVATE_UNKNOWN_STATE' }, 'PROCESSING', null]) {
    const result = await runStatus(env, responses([
      { data: [app] }, { data: [] }, { data: [{ type: 'buildUploads', attributes: { cfBundleVersion: '21', state } }] },
    ]));
    assert.equal(result.receipt.uploadState, 'UNKNOWN');
    assert.equal(result.exitCode, 0);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('mismatched or ambiguous uploads fail safely instead of diagnosing a different build', async () => {
  const upload = { type: 'buildUploads', attributes: { cfBundleVersion: '21', state: { state: 'PROCESSING' } } };
  for (const [uploads, checkState] of [
    [[upload, upload], 'AMBIGUOUS_UPLOAD'],
    [[{ ...upload, attributes: { ...upload.attributes, cfBundleVersion: '22' } }], 'INVALID_RESPONSE'],
  ]) {
    const result = await runStatus(env, responses([{ data: [app] }, { data: [] }, { data: uploads }]));
    assert.equal(result.receipt.checkState, checkState);
    assert.equal(result.receipt.failedEndpoint, 'APP_BUILD_UPLOADS');
    assert.equal(result.receipt.uploadState, 'UNKNOWN');
    assert.equal(result.exitCode, 1);
  }
});

test('an unsupported upload query reports only its endpoint and HTTP status', async () => {
  let count = 0;
  const result = await runStatus(env, async () => {
    if (++count === 1) return new Response(JSON.stringify({ data: [app] }));
    if (count === 2) return new Response(JSON.stringify({ data: [] }));
    return new Response('PRIVATE_APPLE_API_ERROR', { status: 400 });
  });
  assert.equal(result.receipt.checkState, 'API_UNAVAILABLE');
  assert.equal(result.receipt.failedEndpoint, 'APP_BUILD_UPLOADS');
  assert.equal(result.receipt.httpStatus, 400);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('rejects invalid build numbers before using credentials or making requests', async () => {
  for (const value of [undefined, '', '0', '-1', '21.0', ' 21', '21\n', '21;echo private', '1234567890', 21]) {
    assert.throws(() => validateBuildNumber(value));
    const result = await runStatus({ ...env, BUILD_NUMBER: value }, () => assert.fail('must not fetch'));
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.checkState, 'INVALID_BUILD_NUMBER');
    assert.equal(result.receipt.buildNumber, null);
  }
});

test('ambiguous builds and mismatched build versions fail rather than selecting another binary', async () => {
  for (const [builds, state] of [[[build, build], 'AMBIGUOUS_BUILD'], [[{ ...build, attributes: { ...build.attributes, version: '22' } }], 'INVALID_RESPONSE']]) {
    const result = await runStatus(env, responses([{ data: [app] }, { data: builds }]));
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.checkState, state);
  }
});

test('authentication, access, network and malformed-response errors expose only fixed states', async () => {
  for (const [status, state] of [[401, 'AUTHENTICATION_FAILED'], [403, 'ACCESS_DENIED'], [500, 'API_UNAVAILABLE']]) {
    const result = await runStatus(env, async () => new Response('PRIVATE_RESPONSE_TOKEN', { status }));
    assert.equal(result.receipt.checkState, state);
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.failedEndpoint, 'APPS');
    assert.equal(result.receipt.httpStatus, status);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  const network = await runStatus(env, async () => { throw new Error('PRIVATE_NETWORK_TOKEN'); });
  assert.equal(network.receipt.checkState, 'NETWORK_FAILED');
  assert.equal(network.receipt.failedEndpoint, 'APPS');
  assert.equal(network.receipt.httpStatus, null);
  const malformed = await runStatus(env, async () => new Response('PRIVATE_INVALID_JSON'));
  assert.equal(malformed.receipt.checkState, 'INVALID_RESPONSE');
  assert.equal(malformed.receipt.failedEndpoint, 'APPS');
  assert.equal(malformed.receipt.httpStatus, 200);
  const credentials = await runStatus({ ...env, ASC_API_KEY_P8_BASE64: 'PRIVATE_INVALID_KEY' }, () => assert.fail('must not fetch'));
  assert.equal(credentials.receipt.checkState, 'CREDENTIALS_INVALID');
});

test('diagnoses a rejected build query without exposing its URL or Apple error details', async () => {
  let count = 0;
  const result = await runStatus(env, async () => ++count === 1
    ? new Response(JSON.stringify({ data: [app] }))
    : new Response(JSON.stringify({ errors: [{ detail: 'PRIVATE_PROVIDER_DETAIL' }] }), { status: 400 }));
  assert.equal(result.receipt.checkState, 'API_UNAVAILABLE');
  assert.equal(result.receipt.failedEndpoint, 'BUILDS');
  assert.equal(result.receipt.httpStatus, 400);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes(app.id));
});

test('ignores external groups and follows bounded same-endpoint membership pagination', async () => {
  const external = { ...group, id: 'external-group', attributes: { isInternalGroup: false } };
  const result = await checkTestFlightStatus({ buildNumber: '21', token: 'synthetic', fetchImpl: responses([
    { data: [app] }, { data: [build] }, { data: detail }, { data: [external, group] },
    { data: [], links: { next: `https://api.appstoreconnect.apple.com/v1/betaGroups/${group.id}/builds?cursor=synthetic` } },
    { data: [build] },
  ], (url, options, index) => {
    if (index >= 4) assert.equal(url.pathname, `/v1/betaGroups/${group.id}/builds`);
    if (index === 5) assert.equal(url.searchParams.get('cursor'), 'synthetic');
  }) });
  assert.deepEqual(result, expected);
});

test('refuses cross-origin pagination before sending a token to another host', async () => {
  const result = await runStatus(env, responses([
    { data: [app] }, { data: [build] }, { data: detail },
    { data: [], links: { next: `https://untrusted.invalid/v1/apps/${app.id}/betaGroups` } },
  ]));
  assert.equal(result.receipt.checkState, 'INVALID_RESPONSE');
  assert.equal(result.receipt.failedEndpoint, 'APP_BETA_GROUPS');
});

test('CLI emits and saves only the safe receipt on failure without printing supplied secret values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zorid-status-test-'));
  try {
    const file = join(directory, 'receipt.json');
    const result = spawnSync(process.execPath, ['scripts/ios/testflight-status.mjs'], { encoding: 'utf8',
      env: { ...process.env, BUILD_NUMBER: 'invalid-PRIVATE_INPUT', ASC_API_KEY_P8_BASE64: 'PRIVATE_SECRET', STATUS_RECEIPT_PATH: file } });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(JSON.parse(result.stdout), saved);
    assert.equal(saved.checkState, 'INVALID_BUILD_NUMBER');
    assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
