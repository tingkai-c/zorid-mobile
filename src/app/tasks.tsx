import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useWorkspace } from '../features/workspace';
import { Body, Button, Card, colors, Heading, Screen, styles } from '../ui/components';
export default function Tasks() {
  const { tasks, addTask, toggleTask, busy } = useWorkspace(); const [title, setTitle] = useState('');
  const create = async () => { if (!title.trim()) return; if (await addTask(title)) setTitle(''); };
  return <Screen title="Your next things." subtitle="A small list. A little more headspace.">
    <Card><Heading>Add a task</Heading><TextInput style={styles.input} placeholder="What would you like to do?" placeholderTextColor={colors.muted} accessibilityLabel="New task title" value={title} onChangeText={setTitle} maxLength={300} returnKeyType="done" onSubmitEditing={() => void create()} /><Button label="Add task" disabled={busy || !title.trim()} onPress={() => void create()} /></Card>
    <Card><Heading>Tasks · {tasks.length}</Heading>{tasks.length === 0 && <Body>Your list starts here. Add a task, then bring it into a focus session.</Body>}{tasks.map(task => <Pressable key={task.id} accessibilityRole="checkbox" accessibilityLabel={task.title} accessibilityState={{ checked: task.completed, disabled: busy }} disabled={busy} onPress={() => void toggleTask(task.id)} style={[styles.row, { minHeight: 52 }]}><View style={{ width: 26, height: 26, borderRadius: 9, borderWidth: 1, borderColor: colors.accent, backgroundColor: task.completed ? colors.soft : colors.paper, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.accent }}>{task.completed ? '✓' : ''}</Text></View><Text style={{ flex: 1, fontSize: 16, color: task.completed ? colors.muted : colors.ink, textDecorationLine: task.completed ? 'line-through' : 'none' }}>{task.title}</Text></Pressable>)}</Card>
  </Screen>;
}
