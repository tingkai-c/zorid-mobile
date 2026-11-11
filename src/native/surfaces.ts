import type { FocusInput, SurfaceResult } from './focus';
export type { FocusInput, SurfaceResult } from './focus';

export function getSurfaceCapability() {
  return { available: false, reason: 'Widgets and Live Activities require the Zorid iOS native build.' };
}
export async function registerFocusLayouts(): Promise<void> {}
export async function publishFocus(_input: FocusInput): Promise<SurfaceResult> {
  return { available: false, widgetUpdated: false, activityUpdated: false, error: getSurfaceCapability().reason };
}
export async function endFocus(): Promise<SurfaceResult> {
  return publishFocus({ taskTitle: '', status: 'idle' });
}
