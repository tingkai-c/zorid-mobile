import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Text, TextInput } from 'react-native';
import { useConnection } from '../connection/ConnectionProvider';
import { Body, Button, Card, colors, Heading, Screen, styles } from '../ui/components';

export default function SettingsScreen() {
  const connection = useConnection();
  const [link, setLink] = useState('');
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const disabled = connection.loading || connection.busy;
  useFocusEffect(useCallback(() => () => { setScanning(false); setLink(''); }, []));
  async function scan() {
    setCameraError(null);
    try {
      const result = permission?.granted ? permission : await requestPermission();
      if (result.granted) setScanning(true);
      else setCameraError('Camera access is off. Paste your pairing link or enable the camera in system Settings.');
    } catch { setCameraError('Camera is unavailable. Paste your pairing link instead.'); }
  }
  async function pair() {
    setScanning(false);
    if (await connection.pair(link)) setLink('');
  }
  return <Screen title="Settings" subtitle="Connect your personal host and manage app updates.">
    <Card>
      <Heading>{connection.host ? connection.host.hostName : 'Your host'}</Heading>
      <Body>{connection.loading ? 'Restoring connection…' : connection.status}</Body>
      {connection.configuredOrigin ? <Body>Trusted host: {connection.configuredOrigin}</Body> : <Body>This build has no update host configured. Local tools are available; host pairing requires a build configured for your host.</Body>}
      {!connection.native && <Body>Pairing is available in the installed native app.</Body>}
      {connection.error && <Text accessibilityRole="alert" style={{ color: colors.danger }}>{connection.error}</Text>}
      {connection.native && connection.configuredOrigin && !connection.host && <>
        <Body>Generate a pairing QR code on your host, then scan it or paste its link. Pairing lets this host deliver code that runs inside Zorid.</Body>
        <TextInput accessibilityLabel="Pairing link" placeholder="Paste zorid://pair link" placeholderTextColor={colors.muted}
          value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} secureTextEntry
          editable={!disabled} style={styles.input} />
        <Button label="Pair this host" disabled={disabled || !link.trim()} onPress={() => { void pair(); }} />
        <Button label={scanning ? 'Cancel scan' : 'Scan pairing QR'} secondary disabled={disabled}
          onPress={() => { if (scanning) setScanning(false); else void scan(); }} />
        {scanning && <CameraView style={{ height: 260, borderRadius: 16 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => { setLink(data); setScanning(false); }}
          onMountError={() => { setScanning(false); setCameraError('Camera could not start. Paste the pairing link instead.'); }} />}
        {link && <Body>Link captured. Pair this host to confirm the connection.</Body>}
        {cameraError && <Text accessibilityRole="alert" style={{ color: colors.danger }}>{cameraError}</Text>}
        {permission && !permission.granted && !permission.canAskAgain && <Button label="Open system Settings" secondary onPress={() => { void Linking.openSettings(); }} />}
      </>}
      {(connection.host || connection.error) && connection.native && <Button label="Remove saved connection" secondary disabled={disabled} onPress={() => { setLink(''); setScanning(false); void connection.unpair(); }} />}
    </Card>
    <Card>
      <Heading>App updates</Heading>
      <Body>Updates come from your paired host. Downloading keeps your current session open; reload when you are ready.</Body>
      {!connection.updatesEnabled && <Body>Over-the-air updates are disabled in this build. Install a release build configured for your host to enable them.</Body>}
      <Button label={connection.busy ? 'Working…' : 'Check and download update'} disabled={disabled || !connection.host || !connection.updatesEnabled} onPress={() => { void connection.download(); }} />
      {connection.downloaded && <Button label="Reload and apply update" disabled={disabled} onPress={() => { void connection.reload(); }} />}
    </Card>
    <Card><Heading>Your data</Heading><Body>Tasks and focus sessions are stored locally on this device. Pairing deploys app code; it does not enable personal-data synchronization. Removing a connection does not delete your local records.</Body></Card>
  </Screen>;
}
