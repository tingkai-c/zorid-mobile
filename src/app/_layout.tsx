import { ConnectionProvider } from '../connection/ConnectionProvider';
import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { WorkspaceProvider } from '../features/workspace';
import { colors } from '../ui/components';
export default function RootLayout() {
  return <ConnectionProvider><WorkspaceProvider><Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.accent, tabBarInactiveTintColor: colors.muted, tabBarStyle: { backgroundColor: colors.paper, borderTopColor: colors.border }, tabBarLabelStyle: { fontSize: 11 } }}>
    {([['index', 'Today', '◈'], ['tasks', 'Tasks', '✓'], ['focus', 'Focus', '◷'], ['calendar', 'Calendar', '▦'], ['settings', 'Settings', '⚙']] as const).map(([name, title, icon]) => <Tabs.Screen key={name} name={name} options={{ title, tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 23 }} accessibilityElementsHidden>{icon}</Text> }} />)}
  </Tabs></WorkspaceProvider></ConnectionProvider>;
}
