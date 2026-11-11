import { requireOptionalNativeModule } from 'expo';
import { createCoreHapticsClient, type NativeCoreHaptics } from './core-haptics-client';

export const coreHaptics = createCoreHapticsClient(requireOptionalNativeModule<NativeCoreHaptics>('ZoridShell'));
export { createCoreHapticsClient } from './core-haptics-client';
export type { CoreHapticJSON, CoreHapticPattern, CoreHapticParameterID, CoreHapticParameter, CoreHapticControlPoint,
  CoreHapticTiming, CoreHapticConfiguration, CoreHapticCommand, CoreHapticPlayerInfo, CoreHapticPlayerStatus,
  CoreHapticsStatus, CoreHapticPlayer, NativeCoreHaptics } from './core-haptics-client';
