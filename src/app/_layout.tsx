import { Slot } from 'expo-router';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import { launchDestination } from '../shell/launch';
import { SetupScreen } from '../shell/SetupScreen';

export default function RootLayout() {
  const destination = launchDestination({
    platform: Platform.OS,
    development: __DEV__,
    updatesEnabled: Updates.isEnabled,
    embeddedLaunch: Updates.isEmbeddedLaunch,
  });

  return destination === 'setup' ? <SetupScreen /> : <Slot />;
}
