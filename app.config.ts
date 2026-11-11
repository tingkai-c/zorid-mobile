import { relative, resolve } from 'node:path';
import type { ExpoConfig } from 'expo/config';

const updateURL = process.env.ZORID_UPDATE_URL;
const certificate = process.env.ZORID_UPDATE_CERTIFICATE;
if (Boolean(updateURL) !== Boolean(certificate)) throw new Error('Set both ZORID_UPDATE_URL and ZORID_UPDATE_CERTIFICATE, or neither.');
if (updateURL && (new URL(updateURL).protocol !== 'https:' || updateURL !== `${new URL(updateURL).origin}/updates`)) throw new Error('Update URL must be an HTTPS origin followed by /updates.');

const config: ExpoConfig = {
  name: 'Zorid', slug: 'zorid-mobile', scheme: 'zorid', version: '0.1.0',
  orientation: 'portrait', userInterfaceStyle: 'light', icon: './assets/icon.png',
  runtimeVersion: 'zorid-5',
  ios: {
    bundleIdentifier: 'app.zorid.mobile',
    supportsTablet: true,
    buildNumber: process.env.GITHUB_RUN_NUMBER ?? '1',
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSFaceIDUsageDescription: 'Allow Zorid tools to verify your identity with Face ID.',
      NSPhotoLibraryAddUsageDescription: 'Allow Zorid tools to save photos and videos you choose to your library.',
      NSCalendarsUsageDescription: 'Allow Zorid tools to read and manage calendar events you choose.',
      NSCalendarsWriteOnlyAccessUsageDescription: 'Allow Zorid tools to add events to your calendars.',
      NSCalendarsFullAccessUsageDescription: 'Allow Zorid tools to read and manage calendar events you choose.',
      NSRemindersUsageDescription: 'Allow Zorid tools to read and manage reminders you choose.',
      NSRemindersFullAccessUsageDescription: 'Allow Zorid tools to read and manage reminders you choose.',
    },
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
    ['expo-camera', {
      cameraPermission: 'Allow Zorid tools to take photos, scan documents and scan codes.',
      microphonePermission: 'Allow Zorid tools to record audio with videos.', recordAudioAndroid: false,
    }],
    ['expo-audio', {
      microphonePermission: 'Allow Zorid tools to record audio when you choose to record.',
      enableBackgroundPlayback: false, enableBackgroundRecording: false, recordAudioAndroid: false,
    }],
    ['expo-location', {
      locationWhenInUsePermission: 'Allow Zorid tools to use your location while you use location features.',
      locationAlwaysPermission: false, locationAlwaysAndWhenInUsePermission: false,
      locationFullAccuracyPermission: 'Allow Zorid tools to use precise location for the feature you requested.',
      motionUsagePermission: 'Allow Zorid tools to read motion and fitness data when you use those features.',
      isIosBackgroundLocationEnabled: false, isAndroidBackgroundLocationEnabled: false,
      isAndroidForegroundServiceEnabled: false,
    }],
    ['expo-sensors', { motionPermission: 'Allow Zorid tools to read motion and fitness data when you use those features.' }],
    ['expo-contacts', { contactsPermission: 'Allow Zorid tools to use the contacts you choose to share.' }],
    ['expo-widgets', {
      bundleIdentifier: 'app.zorid.mobile.widgets', groupIdentifier: 'group.app.zorid.mobile', enablePushNotifications: false,
      widgets: [{ name: 'ZoridFocus', displayName: 'Zorid Focus', description: 'Your current task and focus countdown.', ios: { supportedFamilies: ['systemSmall', 'systemMedium'], initialLayout: './src/native/FocusWidget.tsx' } }],
    }],
    './plugins/with-zorid-screen-time.cjs',
    './plugins/with-zorid-actions.cjs',
  ],
};
export default config;
