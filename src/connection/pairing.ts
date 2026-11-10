export type PairedHost = { deviceId: string; token: string; hostName: string; updateUrl: string };

export function trustedOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('This build has no configured update host.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('The update host must be an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The update host must be an HTTPS origin.');
  }
  return url.origin;
}

export function parsePairingLink(value: string, configuredOrigin: unknown) {
  const origin = trustedOrigin(configuredOrigin);
  if (value.length > 4096) throw new Error('Pairing link is too long.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Paste a valid Zorid pairing link.'); }
  if (url.protocol !== 'zorid:' || url.hostname !== 'pair' || url.pathname || url.hash || url.username || url.password || url.port) {
    throw new Error('This is not a Zorid pairing link.');
  }
  if (url.searchParams.getAll('url').length !== 1 || url.searchParams.getAll('token').length !== 1 ||
      [...url.searchParams.keys()].some((key) => key !== 'url' && key !== 'token')) throw new Error('Invalid pairing link fields.');
  if (trustedOrigin(url.searchParams.get('url')) !== origin) throw new Error('This link belongs to a different host than this installed app.');
  const token = url.searchParams.get('token')!;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Invalid pairing token.');
  return { origin, token };
}

export function validatePairedHost(value: unknown, configuredOrigin: unknown): PairedHost {
  const origin = trustedOrigin(configuredOrigin);
  if (!value || typeof value !== 'object') throw new Error('Invalid pairing response.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.deviceId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(candidate.deviceId) ||
      typeof candidate.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(candidate.token) ||
      typeof candidate.hostName !== 'string' || !candidate.hostName.trim() || candidate.hostName.length > 100 ||
      candidate.updateUrl !== `${origin}/updates`) throw new Error('Pairing response did not match the configured host.');
  return { deviceId: candidate.deviceId, token: candidate.token, hostName: candidate.hostName, updateUrl: candidate.updateUrl };
}
