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
  for (const resource of ['bundleIds', 'certificates', 'devices']) {
    let response;
    try {
      response = await fetch(`https://api.appstoreconnect.apple.com/v1/${resource}?limit=1`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error('Developer Resources preflight network request failed.');
    }
    // Do not read or print the response body: even error responses can contain private IDs.
    console.log(`Developer Resources ${resource} read preflight: HTTP ${response.status}`);
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(response.status === 401
        ? 'API authentication rejected. Verify the runner team key, key ID and issuer ID belong together.'
        : response.status === 403
          ? 'API access forbidden. Check Developer Resources permissions and current account agreements.'
          : 'Developer Resources preflight failed. Check the reported HTTP status.');
    }
  }
  console.log('Runner API read access confirmed; this does not prove capability registration or write permissions.');
}

if (process.argv[1]?.endsWith('check-api-access.mjs')) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
