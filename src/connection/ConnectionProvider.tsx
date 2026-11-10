import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { parsePairingLink, trustedOrigin, validatePairedHost, type PairedHost } from './pairing';
import { PairingError, pairingStep } from './pairing-errors';

const storageKey = 'zorid.pairedHost.v1';
const configuredOrigin: unknown = Constants.expoConfig?.extra?.updateOrigin;
const native = Platform.OS === 'ios' || Platform.OS === 'android';
const updatesEnabled = native && Updates.isEnabled && !__DEV__;
const storageOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
function applyHeaders(host: PairedHost | null) {
  if (updatesEnabled) Updates.setUpdateRequestHeadersOverride(host ? { Authorization: `Bearer ${host.token}` } : null);
}

type ConnectionState = {
  host: Omit<PairedHost, 'token'> | null; loading: boolean; busy: boolean;
  status: string; error: string | null; downloaded: boolean; updatesEnabled: boolean;
  configuredOrigin: string | null; native: boolean;
  pair(link: string): Promise<boolean>; unpair(): Promise<void>; download(): Promise<void>; reload(): Promise<void>;
};
const ConnectionContext = createContext<ConnectionState | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<PairedHost | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('No host paired. Your local data stays on this device.');
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const operation = useRef(false);
  let origin: string | null = null;
  try { origin = trustedOrigin(configuredOrigin); } catch { /* Unconfigured binaries keep local functionality. */ }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!native) return;
        const saved = await SecureStore.getItemAsync(storageKey, storageOptions);
        if (!saved) { applyHeaders(null); return; }
        const restored = validatePairedHost(JSON.parse(saved), configuredOrigin);
        await pairingStep('updater', () => applyHeaders(restored));
        if (active) { setHost(restored); setStatus('Host paired. Updates are checked when you request them.'); }
      } catch (reason) {
        applyHeaders(null);
        if (active) setError(reason instanceof PairingError ? reason.message : 'Could not restore the host connection. Pair again or remove the saved connection.');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  async function run(action: () => Promise<void>, failure: string): Promise<boolean> {
    if (operation.current || loading) return false;
    operation.current = true; setBusy(true); setError(null);
    try { await action(); return true; }
    catch (reason) { setError(reason instanceof PairingError ? reason.message : failure); return false; }
    finally { operation.current = false; setBusy(false); }
  }
  async function pair(link: string) {
    let offer: ReturnType<typeof parsePairingLink>;
    try { offer = parsePairingLink(link, configuredOrigin); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Invalid pairing link.'); return false; }
    if (!native) { setError('Pairing requires the native app and secure credential storage.'); return false; }
    return run(async () => {
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15_000);
      try {
        let response: Response;
        try {
          response = await fetch(`${offer.origin}/pair`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: abort.signal,
            body: JSON.stringify({ token: offer.token, deviceName: Platform.OS === 'ios' ? 'Zorid iPhone' : 'Zorid Android' }),
          });
        } catch { throw new PairingError(abort.signal.aborted ? 'timeout' : 'network'); }
        if (response.status === 401) throw new PairingError('expired');
        if (!response.ok || (response.url && response.url !== `${offer.origin}/pair`)) throw new PairingError('rejected');
        const paired = await pairingStep('response', async () => validatePairedHost(await response.json(), configuredOrigin));
        await pairingStep('storage', () => SecureStore.setItemAsync(storageKey, JSON.stringify(paired), storageOptions));
        // Preserve the saved credential if native updater setup fails; a corrected binary can restore it.
        await pairingStep('updater', () => applyHeaders(paired));
        setHost(paired); setDownloaded(false);
        setStatus('Host paired. You can now check for a compatible release.');
      } finally { clearTimeout(timer); }
    }, 'Pairing failed. Check Tailscale and use a fresh pairing code from your host.');
  }
  async function unpair() {
    await run(async () => {
      applyHeaders(null);
      if (native) await SecureStore.deleteItemAsync(storageKey, storageOptions);
      setHost(null); setDownloaded(false); setStatus('Connection removed on this device. Revoke this device on the host to invalidate its credential.');
    }, 'Could not remove the saved connection. Try again.');
  }
  async function download() {
    if (!host || !updatesEnabled) return;
    await run(async () => {
      applyHeaders(host); setDownloaded(false); setStatus('Checking your host…');
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable && !check.isRollBackToEmbedded) { setStatus('No compatible update is available.'); return; }
      setStatus('Downloading the update…');
      const result = await Updates.fetchUpdateAsync();
      if (result.isNew || result.isRollBackToEmbedded) { setDownloaded(true); setStatus('Update downloaded. Reload when you are ready.'); }
      else setStatus('This release is already installed.');
    }, 'Update failed. Check your host connection and runtime compatibility, then retry.');
  }
  async function reload() {
    if (!downloaded || !updatesEnabled || !host) return;
    await run(async () => { await Updates.reloadAsync(); }, 'Could not reload the downloaded update.');
  }
  const publicHost = host ? { deviceId: host.deviceId, hostName: host.hostName, updateUrl: host.updateUrl } : null;
  return <ConnectionContext.Provider value={{ host: publicHost, loading, busy, status, error, downloaded, updatesEnabled, configuredOrigin: origin, native, pair, unpair, download, reload }}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('ConnectionProvider is missing.');
  return value;
}
