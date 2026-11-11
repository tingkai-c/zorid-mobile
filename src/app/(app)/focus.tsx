import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { useWorkspace } from '../../features/workspace';
import { workedMs } from '../../domain/focus';
import { Body, Button, Card, colors, Heading, Screen } from '../../ui/components';
import { FocusProtection } from '../../screen-time/FocusProtection';
export default function Focus() {
  const { tasks, active, start, control, busy, now, surfaceError } = useWorkspace(); const [selected, setSelected] = useState<string>();
  const remaining = active ? Math.max(0, Math.ceil((active.targetMs - workedMs(active, now)) / 1000)) : 25 * 60;
  const display = `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;
  return <Screen title="A little focus." subtitle="Twenty-five minutes for one meaningful thing.">
    <Card><Body>{active ? active.taskTitle : tasks.find(task => task.id === selected)?.title ?? 'Open focus'}</Body><Text accessibilityLabel={`${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds remaining`} style={{ color: colors.ink, fontSize: 68, fontWeight: '300', fontVariant: ['tabular-nums'], textAlign: 'center', paddingVertical: 20 }}>{display}</Text><Body>{active ? active.status === 'paused' ? 'Paused. Take your time.' : 'Your timer continues when you leave the app.' : 'Your work intervals will appear in Calendar.'}</Body>
      {active ? <><Button label={active.status === 'paused' ? 'Resume focus' : 'Pause'} disabled={busy} onPress={() => void control(active.status === 'paused' ? 'resume' : 'pause')} /><Button label="Finish & save session" disabled={busy} secondary onPress={() => void control('finish')} /></> : <Button label="Begin focus" disabled={busy} onPress={() => void start(selected)} />}
    </Card>
    {surfaceError && <Body>{surfaceError}</Body>}
    <FocusProtection />
    {!active && <Card><Heading>What are you working on?</Heading>{[{ id: undefined, title: 'Open focus · no task' }, ...tasks.filter(task => !task.completed)].map(task => <Pressable key={task.id ?? 'open'} accessibilityRole="radio" accessibilityState={{ selected: selected === task.id }} onPress={() => setSelected(task.id)} style={{ paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, backgroundColor: selected === task.id ? colors.soft : colors.paper }}><Text style={{ color: colors.ink, fontSize: 16 }}>{selected === task.id ? '●  ' : '○  '}{task.title}</Text></Pressable>)}</Card>}
  </Screen>;
}
