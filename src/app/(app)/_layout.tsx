import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { WorkspaceProvider } from '../../features/workspace';
import { DemoEntrances } from '../../features/DemoEntrances';
import { colors } from '../../ui/components';

// These tabs belong to the demo app. The launcher imposes no navigation.
export default function DemoLayout() {
  return <WorkspaceProvider><DemoEntrances /><Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.accent, tabBarInactiveTintColor: colors.muted, tabBarStyle: { backgroundColor: colors.paper, borderTopColor: colors.border }, tabBarLabelStyle: { fontSize: 11 } }}>
    {([['index', 'Today', '◈'], ['tasks', 'Tasks', '✓'], ['focus', 'Focus', '◷'], ['calendar', 'Calendar', '▦']] as const).map(([name, title, icon]) => <Tabs.Screen key={name} name={name} options={{ title, tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 23 }} accessibilityElementsHidden>{icon}</Text> }} />)}
  </Tabs></WorkspaceProvider>;
}
