import { useCallback, useEffect, useState } from 'react';
import { AppState, Switch, Text, View } from 'react-native';
import { useWorkspace } from '../features/workspace';
import { Body, Button, Card, colors, Heading } from '../ui/components';
import { screenTime, type ScreenTimeMode, type ScreenTimeStatus } from '.';
import { disableFocusBlocking } from './disable';

const appId = 'productivity';
const policyId = 'focus';

export function FocusProtection() {
  const { active, busy, focusPolicyId, setFocusPolicy } = useWorkspace();
  const [status, setStatus] = useState<ScreenTimeStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setStatus(await screenTime.status(appId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Screen Time could not refresh.'); }
  }, []);
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const next = await screenTime.status(appId);
        if (mounted) setStatus(next);
      } catch (reason) { if (mounted) setError(reason instanceof Error ? reason.message : 'Screen Time could not refresh.'); }
    };
    void check();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void check(); });
    // Native effects and extension actions commit independently of React state.
    const interval = screenTime.available ? setInterval(() => {
      if (AppState.currentState === 'active') void check();
    }, 3000) : undefined;
    return () => { mounted = false; subscription.remove(); if (interval) clearInterval(interval); };
  }, [active?.id, active?.status]);

  async function run(operation: () => Promise<void>) {
    setWorking(true); setError(null);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Screen Time could not update.'); }
    finally { await refresh(); setWorking(false); }
  }
  async function setEnabled(enabled: boolean) {
    if (enabled) {
      const current = await screenTime.status(appId);
      const selectedPolicy = current.policies.find(item => item.id === policyId);
      if (screenTime.shieldAvailable && !selectedPolicy?.customShield) await screenTime.configureShield(appId, policyId, {
        title: { text: 'Focus in progress', color: '#203D38' },
        subtitle: { text: 'Give this task your attention. Pause or finish your session in Zorid to use this app.', color: '#65756F' },
        icon: { systemName: 'timer' }, backgroundColor: '#F7F6F2', primaryButtonBackgroundColor: '#176B58',
        primaryButtonLabel: { text: 'Return to focus', color: '#FFFFFF' },
        ...(current.shieldCapabilities?.openApp ? { secondaryButtonLabel: { text: 'Open Zorid', color: '#176B58' } } : {}),
        actions: { primary: 'close', ...(current.shieldCapabilities?.openApp ? { secondary: 'openApp' as const } : {}) },
      });
      if (!await setFocusPolicy(policyId)) throw new Error('The app blocking preference could not be saved.');
      return;
    }
    const result = await disableFocusBlocking({ saveDisabledPreference: () => setFocusPolicy(null),
      clear: () => screenTime.clear(appId), deletePolicy: () => screenTime.deletePolicy(appId, policyId) });
    setStatus(result.status);
    if (result.policyReset) {
      throw new Error('App blocking is off. The app selection was reset because the saved preference could not be disabled. Choose your apps again before enabling blocking.');
    }
  }
  const policy = status?.policies.find(item => item.id === policyId);
  const disabled = working || busy;
  const authorized = status?.authorization === 'approved';
  const usable = policy && (policy.mode === 'allowlist' || policy.applicationCount + policy.categoryCount > 0);
  const enabled = focusPolicyId === policyId;
  const edit = (mode: ScreenTimeMode) => run(async () => {
    setStatus(await screenTime.editPolicy(appId, policyId, mode));
  });

  return <Card>
    <Heading>App blocking</Heading>
    {!status ? <Body>Checking Screen Time…</Body> : !status.available ? <Body>{status.error ?? 'App blocking is available in the Zorid iPhone build.'}</Body> : <>
      {!authorized ? <>
        <Body>Allow Screen Time access to choose which apps you can use during focus.</Body>
        <Button label={status.authorization === 'denied' ? 'Retry Screen Time authorization' : 'Allow Screen Time access'} disabled={disabled}
          onPress={() => void run(async () => { setStatus(await screenTime.requestAuthorization(appId)); })} />
      </> : <>
        <Body>{policy ? policy.mode === 'blocklist'
          ? `Block ${policy.applicationCount} selected apps and ${policy.categoryCount} categories during focus.`
          : `Allow ${policy.applicationCount} selected apps during focus. Zorid remains available.`
          : 'Choose a blocklist or allowlist. Your app selections stay on this iPhone.'}</Body>
        <Button label={policy?.mode === 'blocklist' ? 'Edit blocked apps' : 'Choose apps to block'} secondary disabled={disabled || Boolean(active)} onPress={() => void edit('blocklist')} />
        <Button label={policy?.mode === 'allowlist' ? 'Edit allowed apps' : 'Choose an allowlist'} secondary disabled={disabled || Boolean(active)} onPress={() => void edit('allowlist')} />
        {active && <Body>Finish this session before changing the selected apps.</Body>}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <Text style={{ flex: 1, color: colors.ink, fontSize: 16 }}>Use this list during focus</Text>
          <Switch accessibilityLabel="Use app blocking during focus" value={enabled} disabled={disabled || (!usable && !enabled)}
            onValueChange={value => void run(() => setEnabled(value))} trackColor={{ true: colors.accent }} />
        </View>
        <Body>{status.active ? 'App blocking is active on this iPhone.' : enabled
          ? active?.status === 'paused' ? 'Blocking is paused with your timer.' : 'Enabled for focus. Blocking is not currently active.'
          : 'App blocking is off.'}</Body>
        <Body>Pausing or finishing clears Zorid’s restrictions. Timed release uses iOS background monitoring; it may update when you next use the phone.</Body>
      </>}
      {(enabled || status.active) && <Button label="Turn off app blocking" secondary disabled={disabled}
        onPress={() => void run(() => setEnabled(false))} />}
      {status.error && <Body>{status.error}</Body>}
    </>}
    {error && <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text>}
  </Card>;
}
