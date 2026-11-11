import { requireOptionalNativeModule } from 'expo';
import { createScreenTimeClient, type NativeScreenTime } from './client';

/** Selection and authorization always remain on the person's device. */
export const screenTime = createScreenTimeClient(requireOptionalNativeModule<NativeScreenTime>('ZoridScreenTime'));
export { createScreenTimeClient, parseScreenTimeStatus } from './client';
export type { NativeScreenTime, ScreenTimeMode, ScreenTimePolicy, ScreenTimeStatus } from './client';
