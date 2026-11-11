import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { appURL } from '../shell/routes';
import { registerAppRoutes } from '../shell/routes-client';
import { setQuickActions } from '../shell/shortcuts';
import { Body } from '../ui/components';
import { useWorkspace } from './workspace';

/** Downloaded app registration; the launcher has no knowledge of these pages. */
export function DemoEntrances() {
  const router = useRouter();
  const { loading, error } = useWorkspace();
  const [routeError, setRouteError] = useState<string | null>(null);
  useEffect(() => {
    if (loading || error) return;
    const remove = registerAppRoutes('productivity', route => {
      const page = route.path.join('/');
      if (!['', 'today', 'focus', 'tasks', 'calendar'].includes(page)) throw new Error('This app does not recognize that destination.');
      router.navigate(page === 'focus' ? '/focus' : page === 'tasks' ? '/tasks' : page === 'calendar' ? '/calendar' : '/');
      setRouteError(null);
    }, e => setRouteError(e instanceof Error ? e.message : 'The destination could not open.'));
    void setQuickActions('productivity', [
      { id: 'focus', title: 'Open focus', systemImage: 'timer', url: appURL('productivity', ['focus']) },
      { id: 'tasks', title: 'Tasks', systemImage: 'checklist', url: appURL('productivity', ['tasks']) },
      { id: 'calendar', title: 'Work sessions', systemImage: 'calendar', url: appURL('productivity', ['calendar']) },
    ]).catch(() => setRouteError('Home Screen actions could not update.'));
    return remove;
  }, [loading, error, router]);
  return routeError ? <Body>{routeError}</Body> : null;
}
