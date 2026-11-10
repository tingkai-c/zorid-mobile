import { Text, View } from 'react-native';
import { useWorkspace } from '../../features/workspace';
import { workedMs } from '../../domain/focus';
import { Body, Card, colors, Heading, Screen } from '../../ui/components';
export default function Calendar() {
  const { sessions, now } = useWorkspace();
  const completed = sessions.filter(session => session.status === 'completed');
  const days = [...new Set(completed.map(session => new Date(session.startedAt).toDateString()))];
  return <Screen title="Time well spent." subtitle="A record of your work, with pauses left out.">
    {!completed.length && <Card><Heading>Your first session goes here</Heading><Body>Finish a focus session to see the task, time, and actual work intervals.</Body></Card>}
    {days.map(day => <Card key={day}><Heading>{day}</Heading>{completed.filter(session => new Date(session.startedAt).toDateString() === day).map(session => <View key={session.id} style={{ gap: 5, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14 }}><Text style={{ color: colors.ink, fontSize: 17, fontWeight: '600' }}>{session.taskTitle}</Text><Body>{Math.floor(workedMs(session, now) / 60_000)} min focused · {new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Body>{session.intervals.map((interval, i) => <Body key={i}>{new Date(interval.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {new Date(interval.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Body>)}</View>)}</Card>)}
  </Screen>;
}
