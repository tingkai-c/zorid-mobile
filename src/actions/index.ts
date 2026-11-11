import { requireOptionalNativeModule } from 'expo';
import { randomUUID } from 'expo-crypto';
import { createActionClient } from './client';
import type { NativeActions, NativeActionSurfaces } from './types';

export const actions = createActionClient(
  requireOptionalNativeModule<NativeActions>('ZoridActions'),
  requireOptionalNativeModule<NativeActionSurfaces>('ExpoWidgets'),
  randomUUID,
);
export { createActionClient } from './client';
export { ACTION_RUNTIME_VERSION, ACTION_TARGET_PREFIX, ACTIVITY_ACTION_TARGET_PREFIX, encodeActionTarget, decodeActionTarget, serializeActionBundle, serializeActionRequest } from './codec';
export type * from './types';
