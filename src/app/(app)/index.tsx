import { router } from 'expo-router';
import { Text } from 'react-native';
import { useWorkspace } from '../../features/workspace';
import { workedMs } from '../../domain/focus';
import { Body, Button, Card, colors, Heading, Screen } from '../../ui/components';
export default function Today() {
  const { tasks, sessions, active, now } = useWorkspace();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const minutes = Math.floor(sessions.reduce((sum, session) => sum + session.intervals.reduce((total, interval) => total + Math.max(0, Math.min(interval.endedAt, now) - Math.max(interval.startedAt, startOfDay.getTime())), 0), 0) / 60_000);
  return <Screen title="Make room for today." subtitle="A quiet home for your tools, tasks, and time.">
    <Card><Heading>{active ? 'Your focus, held here' : 'One thing at a time'}</Heading><Body>{active ? `${active.taskTitle} · ${active.status}` : 'Choose something worth your attention. Everything is saved locally, even offline.'}</Body><Button label={active ? 'Return to focus' : 'Start a focus session'} onPress={() => router.navigate('/focus')} /></Card>
    <Card><Text style={{ fontSize: 42, fontWeight: '600', color: colors.ink }}>{tasks.filter(task => !task.completed).length}</Text><Heading>Tasks still open</Heading><Body>{minutes} minutes recorded today{active?.status === 'running' ? ` · ${Math.floor(workedMs(active, now) / 60_000)} minutes in progress` : ''}</Body><Button label="View your tasks" secondary onPress={() => router.navigate('/tasks')} /></Card>
    <Body>Local-first foundation · Device sync is not connected yet.</Body>
  </Screen>;
}
