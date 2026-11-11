import { requireOptionalNativeModule } from 'expo';
import { createDeviceClient, type NativeDevice } from './client';

export * from './client';
export const device = createDeviceClient(requireOptionalNativeModule<NativeDevice>('ZoridDevice'));
