import { requireOptionalNativeModule } from 'expo';
import { createScreenTimeClient, type NativeScreenTime } from './client';

/** Selection and authorization always remain on the person's device. */
export const screenTime = createScreenTimeClient(requireOptionalNativeModule<NativeScreenTime>('ZoridScreenTime'));
export { createScreenTimeClient, parseScreenTimeStatus, screenTimeBlurStyles } from './client';
export type { NativeScreenTime, ScreenTimeMode, ScreenTimePolicy, ScreenTimeStatus, ScreenTimeShieldResponse, ScreenTimeShieldConfig, ScreenTimeShieldLabel, ScreenTimeShieldColor, ScreenTimeShieldIcon, ScreenTimeBlurStyle } from './client';
