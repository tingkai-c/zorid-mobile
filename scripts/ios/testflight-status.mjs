// Read-only ASC status. Only the fixed receipt schema may reach logs/artifacts.
// API references: developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
// and developer.apple.com/documentation/appstoreconnectapi/get-v1-betagroups.
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { makeToken } from './check-api-access.mjs';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = 'app.zorid.mobile';
const PROCESSING = ['PROCESSING', 'FAILED', 'INVALID', 'VALID'];
const AUDIENCE = ['INTERNAL_ONLY', 'APP_STORE_ELIGIBLE'];
const INTERNAL = ['PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE',
  'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', 'EXPIRED', 'IN_EXPORT_COMPLIANCE_REVIEW'];
const FAILURE_STATES = ['INVALID_BUILD_NUMBER', 'CREDENTIALS_INVALID', 'AUTHENTICATION_FAILED',
  'ACCESS_DENIED', 'API_UNAVAILABLE', 'NETWORK_FAILED', 'INVALID_RESPONSE', 'APP_NOT_FOUND', 'AMBIGUOUS_BUILD'];

class StatusFailure extends Error {
  constructor(state) { super(state); this.state = state; }
}

export function validateBuildNumber(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new StatusFailure('INVALID_BUILD_NUMBER');
  }
  return value;
}

function receipt(buildNumber, checkState) {
  return { buildNumber, checkState, processingState: 'UNKNOWN', buildAudienceType: 'UNKNOWN',
    internalBuildState: 'UNKNOWN', internalGroupAssigned: false };
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new StatusFailure('INVALID_RESPONSE');
  }
  return value;
}

function collection(response, type) {
  if (!Array.isArray(response?.data) || response.data.some(item => item?.type !== type)) {
    throw new StatusFailure('INVALID_RESPONSE');
  }
  return response.data;
}

function safeState(value, allowed) { return allowed.includes(value) ? value : 'UNKNOWN'; }

export async function checkTestFlightStatus({ buildNumber, token, fetchImpl = fetch }) {
  validateBuildNumber(buildNumber);
  async function get(path, parameters = {}) {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    } catch { throw new StatusFailure('NETWORK_FAILED'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new StatusFailure(response.status === 401 ? 'AUTHENTICATION_FAILED'
        : response.status === 403 ? 'ACCESS_DENIED' : 'API_UNAVAILABLE');
    }
    try { return await response.json(); }
    catch { throw new StatusFailure('INVALID_RESPONSE'); }
  }

  const apps = collection(await get('/v1/apps', {
    'filter[bundleId]': BUNDLE_ID, 'fields[apps]': 'bundleId', limit: '2',
  }), 'apps');
  if (apps.length !== 1 || apps[0].attributes?.bundleId !== BUNDLE_ID) {
    throw new StatusFailure('APP_NOT_FOUND');
  }
  const appId = identifier(apps[0].id);
  const builds = collection(await get('/v1/builds', {
    'filter[app]': appId, 'filter[version]': buildNumber, 'filter[preReleaseVersion.platform]': 'IOS',
    'fields[builds]': 'version,processingState,buildAudienceType', limit: '2',
  }), 'builds');
  if (builds.length === 0) return receipt(buildNumber, 'BUILD_NOT_FOUND');
  if (builds.length !== 1) throw new StatusFailure('AMBIGUOUS_BUILD');
  const build = builds[0], buildId = identifier(build.id);
  if (build.attributes?.version !== buildNumber) throw new StatusFailure('INVALID_RESPONSE');
  const detail = await get(`/v1/builds/${encodeURIComponent(buildId)}/buildBetaDetail`, {
    'fields[buildBetaDetails]': 'internalBuildState',
  });
  if (detail?.data?.type !== 'buildBetaDetails') throw new StatusFailure('INVALID_RESPONSE');
  const groups = collection(await get('/v1/betaGroups', {
    'filter[app]': appId, 'filter[builds]': buildId, 'filter[isInternalGroup]': 'true',
    'fields[betaGroups]': 'isInternalGroup', limit: '1',
  }), 'betaGroups');
  if (groups.some(group => group.attributes?.isInternalGroup !== true)) throw new StatusFailure('INVALID_RESPONSE');
  return { buildNumber, checkState: 'FOUND',
    processingState: safeState(build.attributes.processingState, PROCESSING),
    buildAudienceType: safeState(build.attributes.buildAudienceType, AUDIENCE),
    internalBuildState: safeState(detail.data.attributes?.internalBuildState, INTERNAL),
    internalGroupAssigned: groups.length > 0 };
}

export async function runStatus(env = process.env, fetchImpl = fetch) {
  let buildNumber = null;
  try {
    buildNumber = validateBuildNumber(env.BUILD_NUMBER);
    const encodedKey = env.ASC_API_KEY_P8_BASE64?.replace(/\s/g, '');
    if (!encodedKey || encodedKey.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)
      || !env.ASC_API_KEY_ID || !env.ASC_API_ISSUER_ID) throw new StatusFailure('CREDENTIALS_INVALID');
    let token;
    try { token = makeToken(Buffer.from(encodedKey, 'base64'), env.ASC_API_KEY_ID, env.ASC_API_ISSUER_ID); }
    catch { throw new StatusFailure('CREDENTIALS_INVALID'); }
    return { receipt: await checkTestFlightStatus({ buildNumber, token, fetchImpl }), exitCode: 0 };
  } catch (error) {
    const state = error instanceof StatusFailure && FAILURE_STATES.includes(error.state) ? error.state : 'API_UNAVAILABLE';
    return { receipt: receipt(buildNumber, state), exitCode: 1 };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runStatus();
  console.log(JSON.stringify(result.receipt));
  try { writeFileSync(process.env.STATUS_RECEIPT_PATH ?? 'testflight-status.json', JSON.stringify(result.receipt, null, 2) + '\n'); }
  catch { console.error('STATUS_RECEIPT_WRITE_FAILED'); process.exitCode = 1; }
  if (result.exitCode) process.exitCode = result.exitCode;
}
