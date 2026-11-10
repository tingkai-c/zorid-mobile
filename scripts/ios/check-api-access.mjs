// Check the exact runner credentials without printing tokens, response data or IDs.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function makeToken(key, keyId, issuerId, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({
    iss: issuerId, iat: now, exp: now + 300, aud: 'appstoreconnect-v1',
  })}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

async function main() {
  const directory = join(process.env.RUNNER_TEMP, 'zorid-signing');
  if (!existsSync(join(directory, 'api.json'))) return;
  const { keyId, issuerId } = JSON.parse(readFileSync(join(directory, 'api.json'), 'utf8'));
  let token;
  try {
    token = makeToken(readFileSync(join(directory, 'AuthKey.p8')), keyId, issuerId);
  } catch {
    throw new Error('API private key could not sign an ES256 authentication token. Check key format.');
  }
  const testflight = process.env.BUILD_MODE === 'testflight';
  const bundleId = 'app.zorid.mobile';
  const preflight = testflight ? 'App Store Connect' : 'Developer Resources';
  for (const resource of testflight ? ['apps'] : ['bundleIds', 'certificates', 'devices']) {
    const url = new URL(`https://api.appstoreconnect.apple.com/v1/${resource}`);
    url.searchParams.set('limit', '1');
    if (testflight) url.searchParams.set('filter[bundleId]', bundleId);
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error(`${preflight} preflight network request failed.`);
    }
    // Even error responses can contain private IDs.
    console.log(`${preflight} ${resource} read preflight: HTTP ${response.status}`);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401
        ? 'API authentication rejected. Verify the runner team key, key ID and issuer ID belong together.'
        : response.status === 403
          ? `API access forbidden. Check ${preflight} permissions and current account agreements.`
          : `${preflight} preflight failed. Check the reported HTTP status.`);
    }
    if (testflight) {
      const result = await response.json().catch(() => null);
      if (!Array.isArray(result?.data)) throw new Error('App Store Connect app lookup returned an invalid response.');
      if (!result.data.some((app) => app.attributes?.bundleId === bundleId)) {
        throw new Error('Create or grant the runner access to the Zorid app record in App Store Connect before uploading.');
      }
    } else {
      await response.body?.cancel();
    }
  }
  console.log(testflight ? 'Zorid app record confirmed in App Store Connect.'
    : 'Runner API read access confirmed; this does not prove capability registration or write permissions.');
}

if (process.argv[1]?.endsWith('check-api-access.mjs')) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
