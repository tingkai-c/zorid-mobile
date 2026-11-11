import { requireOptionalNativeModule } from 'expo';
import { createHapticsClient, type NativeHaptics } from './haptics-client';

export const haptics = createHapticsClient(requireOptionalNativeModule<NativeHaptics>('ZoridShell'));
export { createHapticsClient } from './haptics-client';
export type { HapticImpactStyle, HapticNotificationType, HapticKind, HapticPoint, HapticOptions,
  HapticImpactOptions, HapticsStatus, NativeHaptics } from './haptics-client';
