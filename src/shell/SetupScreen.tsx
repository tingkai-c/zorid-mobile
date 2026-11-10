import { requireOptionalNativeModule } from 'expo';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface NativeShell {
  openSettings(): Promise<boolean | void>;
}

/** Recovery surface only; native code presents Zorid Settings on first launch. */
export function SetupScreen() {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  async function openSettings() {
    setOpening(true);
    setError(null);
    try {
      const shell = requireOptionalNativeModule<NativeShell>('ZoridShell');
      if (!shell) throw new Error('Install the latest Zorid build to open Zorid Settings.');
      if (await shell.openSettings() === false) throw new Error('Could not open Zorid Settings. Try again.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open Zorid Settings. Try again.');
    } finally {
      setOpening(false);
    }
  }

  return <SafeAreaView style={styles.screen}>
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>Set up your app</Text>
      <Text style={styles.body}>Connect to your computer to install an app. Once installed, it opens here, even offline.</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: opening }} disabled={opening} onPress={openSettings} style={({ pressed }) => [styles.button, { opacity: opening || pressed ? 0.6 : 1 }]}>
        <Text style={styles.buttonText}>{opening ? 'Opening settings…' : 'Open Zorid Settings'}</Text>
      </Pressable>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Text style={styles.body}>Hold three fingers on the screen, shake your iPhone, or use Zorid Settings from the app icon’s quick actions.</Text>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F6F2' },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 24, width: '100%', maxWidth: 600, alignSelf: 'center' },
  title: { fontSize: 36, fontWeight: '700', color: '#203D38' },
  body: { fontSize: 16, lineHeight: 24, color: '#65756F' },
  button: { minHeight: 48, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: '#176B58', alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF', textAlign: 'center' },
  error: { fontSize: 16, lineHeight: 24, color: '#9B3A31' },
});
