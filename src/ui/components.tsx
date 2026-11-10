import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWorkspace } from '../features/workspace';
export const colors = { background: '#F7F6F2', paper: '#FFFFFF', ink: '#203D38', muted: '#65756F', accent: '#176B58', border: '#E1E7DE', soft: '#E7F0E8', danger: '#9B3A31' };
export function Screen({ title, subtitle, children }: {title: string; subtitle: string; children: React.ReactNode}) {
  const { loading, error, retry } = useWorkspace(); const insets = useSafeAreaInsets();
  return <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>ZORID · ON THIS DEVICE</Text><Text accessibilityRole="header" style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text>
    {error && <Card><Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text><Button label="Retry local storage" onPress={retry} secondary /></Card>}
    {loading ? <ActivityIndicator size="large" color={colors.accent} accessibilityLabel="Loading local records" /> : children}
  </ScrollView>;
}
export function Card({ children }: {children: React.ReactNode}) { return <View style={styles.card}>{children}</View>; }
export function Heading({ children }: {children: React.ReactNode}) { return <Text accessibilityRole="header" style={styles.heading}>{children}</Text>; }
export function Body({ children }: {children: React.ReactNode}) { return <Text style={styles.body}>{children}</Text>; }
export function Button({ label, onPress, secondary = false, disabled = false }: {label: string; onPress(): void; secondary?: boolean; disabled?: boolean}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, { opacity: disabled ? .45 : pressed ? .7 : 1 }]}><Text style={[styles.buttonText, secondary && { color: colors.accent }]}>{label}</Text></Pressable>;
}
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, content: { padding: 24, paddingBottom: 40, gap: 18, width: '100%', maxWidth: 720, alignSelf: 'center' },
  eyebrow: { color: colors.accent, fontSize: 11, letterSpacing: 2, fontWeight: '700' }, title: { fontSize: 36, fontWeight: '700', color: colors.ink }, subtitle: { fontSize: 16, lineHeight: 24, color: colors.muted, marginBottom: 6 },
  card: { backgroundColor: colors.paper, borderRadius: 22, borderWidth: 1, borderColor: colors.border, padding: 20, gap: 14 }, heading: { fontSize: 20, fontWeight: '600', color: colors.ink }, body: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  button: { minHeight: 48, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 13, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }, secondary: { backgroundColor: colors.soft }, buttonText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  input: { borderColor: colors.border, borderWidth: 1, borderRadius: 14, minHeight: 50, padding: 14, color: colors.ink, fontSize: 16, backgroundColor: colors.background }, row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
