import type { ExpoConfig } from 'expo/config';

const updateURL = process.env.ZORID_UPDATE_URL;
const certificate = process.env.ZORID_UPDATE_CERTIFICATE;
if (Boolean(updateURL) !== Boolean(certificate)) throw new Error('Set both ZORID_UPDATE_URL and ZORID_UPDATE_CERTIFICATE, or neither.');
if (updateURL && (new URL(updateURL).protocol !== 'https:' || new URL(updateURL).pathname !== '/updates')) throw new Error('Update URL must be an HTTPS origin followed by /updates.');

const config: ExpoConfig = {
  name: 'Zorid', slug: 'zorid-mobile', scheme: 'zorid', version: '0.1.0',
  orientation: 'portrait', userInterfaceStyle: 'light', icon: './assets/icon.png',
  runtimeVersion: 'zorid-1',
  ios: { bundleIdentifier: 'app.zorid.mobile', supportsTablet: true, buildNumber: process.env.GITHUB_RUN_NUMBER ?? '1' },
  android: { package: 'app.zorid.mobile' },
  web: { bundler: 'metro', output: 'single', favicon: './assets/favicon.png' },
  updates: updateURL ? {
    enabled: true, url: updateURL, checkAutomatically: 'NEVER', fallbackToCacheTimeout: 0,
    codeSigningCertificate: certificate,
    codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
  } : { enabled: false },
  extra: { updateOrigin: updateURL ? new URL(updateURL).origin : null },
  plugins: [
    'expo-router', 'expo-sqlite', 'expo-secure-store',
    ['expo-camera', { cameraPermission: 'Allow Zorid to scan your laptop pairing code.', microphonePermission: false, recordAudioAndroid: false }],
    ['expo-widgets', {
      bundleIdentifier: 'app.zorid.mobile.widgets', groupIdentifier: 'group.app.zorid.mobile', enablePushNotifications: false,
      widgets: [{ name: 'ZoridFocus', displayName: 'Zorid Focus', description: 'Your current task and focus countdown.', ios: { supportedFamilies: ['systemSmall', 'systemMedium'], initialLayout: './src/native/FocusWidget.tsx' } }],
    }],
  ],
};
export default config;
