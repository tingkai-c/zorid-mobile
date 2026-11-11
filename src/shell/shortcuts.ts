import { requireOptionalNativeModule } from 'expo';
import { validateQuickActions, type QuickAction } from './routes';

type ShortcutNativeModule = { setQuickActions(appId: string, json: string): Promise<void> };

/** The current downloaded app owns the three dynamic menu slots. Calling with
 * [] removes its menu items; the installed Zorid Settings shortcut remains. */
export async function setQuickActions(appId: string, items: readonly QuickAction[]): Promise<boolean> {
  const validated = validateQuickActions(appId, items);
  const native = requireOptionalNativeModule<ShortcutNativeModule>('ZoridShell');
  if (!native?.setQuickActions) return false;
  await native.setQuickActions(appId, JSON.stringify(validated));
  return true;
}
