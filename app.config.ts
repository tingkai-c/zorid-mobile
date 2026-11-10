import { relative, resolve } from 'node:path';
import type { ExpoConfig } from 'expo/config';

const updateURL = process.env.ZORID_UPDATE_URL;
const certificate = process.env.ZORID_UPDATE_CERTIFICATE;
if (Boolean(updateURL) !== Boolean(certificate)) throw new Error('Set both ZORID_UPDATE_URL and ZORID_UPDATE_CERTIFICATE, or neither.');
if (updateURL && (new URL(updateURL).protocol !== 'https:' || updateURL !== `${new URL(updateURL).origin}/updates`)) throw new Error('Update URL must be an HTTPS origin followed by /updates.');

const config: ExpoConfig = {
  name: 'Zorid', slug: 'zorid-mobile', scheme: 'zorid', version: '0.1.0',
  orientation: 'portrait', userInterfaceStyle: 'light', icon: './assets/icon.png',
  runtimeVersion: 'zorid-2',
  ios: {
    bundleIdentifier: 'app.zorid.mobile',
    supportsTablet: true,
    buildNumber: process.env.GITHUB_RUN_NUMBER ?? '1',
    config: { usesNonExemptEncryption: false },
  },
  android: { package: 'app.zorid.mobile' },
  web: { bundler: 'metro', output: 'single', favicon: './assets/favicon.png' },
  updates: updateURL ? {
    enabled: true, url: updateURL, checkAutomatically: 'NEVER', fallbackToCacheTimeout: 0,
    // Expo permits overriding only header keys declared in the installed binary.
    // This public placeholder grants no access; pairing supplies the real bearer.
    requestHeaders: { Authorization: 'Bearer unpaired' },
    codeSigningCertificate: relative(process.cwd(), resolve(certificate!)),
    codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
  } : { enabled: false },
  extra: { updateOrigin: updateURL ? new URL(updateURL).origin : null },
  plugins: [
    './plugins/with-zorid-shell.cjs',
    ['expo-router', { headers: { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Opener-Policy': 'same-origin' } }],
    'expo-sqlite', 'expo-secure-store',
    ['expo-camera', { cameraPermission: 'Allow Zorid to scan your laptop pairing code.', microphonePermission: false, recordAudioAndroid: false }],
    ['expo-widgets', {
      bundleIdentifier: 'app.zorid.mobile.widgets', groupIdentifier: 'group.app.zorid.mobile', enablePushNotifications: false,
      widgets: [{ name: 'ZoridFocus', displayName: 'Zorid Focus', description: 'Your current task and focus countdown.', ios: { supportedFamilies: ['systemSmall', 'systemMedium'], initialLayout: './src/native/FocusWidget.tsx' } }],
    }],
  ],
};
export default config;
