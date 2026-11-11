import { requireOptionalNativeModule } from 'expo';
import { focusTimeline, presentFocus, type FocusInput, type SurfaceResult } from './focus';
export type { FocusInput, SurfaceResult } from './focus';

export function getSurfaceCapability() {
  const available = !!requireOptionalNativeModule('ExpoWidgets') && !!requireOptionalNativeModule('ExpoUI');
  return { available, reason: available ? undefined : 'Install the Zorid native build to enable widgets and Live Activities.' };
}

/** Persist the current downloaded layouts before a cold native action needs
 * them. Registration changes layout source, never the ordered surface data. */
export async function registerFocusLayouts(): Promise<void> {
  if (!getSurfaceCapability().available) throw new Error('This binary cannot render focus surfaces.');
  await Promise.all([import('./FocusWidget'), import('./FocusActivity')]);
}

// Serialize app events: concurrent start/update/end calls must not create duplicate activities.
let pending: Promise<unknown> = Promise.resolve();
function serialize(action: () => Promise<SurfaceResult>): Promise<SurfaceResult> {
  const next = pending.then(action, action);
  pending = next;
  return next;
}

export function publishFocus(input: FocusInput): Promise<SurfaceResult> {
  return serialize(async () => {
    const capability = getSurfaceCapability();
    const result: SurfaceResult = { available: capability.available, widgetUpdated: false, activityUpdated: false };
    if (!capability.available) return { ...result, error: capability.reason };
    try {
      const [{ default: widget }, { default: activity }] = await Promise.all([
        import('./FocusWidget'), import('./FocusActivity'),
      ]);
      const now = Date.now();
      const props = input.presentation ?? presentFocus(input, now);
      widget.updateTimeline(focusTimeline(props, now));
      result.widgetUpdated = true;
      const instances = activity.getInstances();
      if (props.status === 'idle' || props.status === 'completed') {
        await Promise.all(instances.map((instance) => instance.end('immediate', props)));
      } else {
        const staleDate = props.status === 'running' ? new Date(props.endsAt) : undefined;
        const [existing, ...duplicates] = instances;
        if (existing) await existing.update(props, staleDate);
        else activity.start(props, 'zorid://focus', staleDate);
        await Promise.all(duplicates.map((instance) => instance.end('immediate')));
      }
      result.activityUpdated = true;
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Native surface update failed.';
    }
    return result;
  });
}

export function endFocus(): Promise<SurfaceResult> {
  return publishFocus({ taskTitle: '', status: 'idle' });
}
