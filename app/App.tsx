/**
 * Active Sportz — production app shell.
 *
 * Routing is driven by two store fields:
 *   - `appScreen`: 'session' | 'library'. The Library is a sibling to
 *     the Setup/Recording/Done flow, not a sub-state of it (M5).
 *   - `sessionState`: when `appScreen === 'session'`, decides which of
 *     Setup / Recording / Done to mount.
 *
 * On launch: run the M5 crash-recovery sweep before any screen mounts.
 * Per ADR-0007 it's silent — we show a brief "Restoring previous
 * Sessions…" overlay only while the sweep is in flight, and only if
 * there's anything to inspect. Once the sweep is done the normal
 * routing takes over and any finalized orphans appear in the Library.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Pressable,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useCameraPermission } from 'react-native-vision-camera';
import { SetupScreen } from './src/screens/SetupScreen';
import { RecordingScreen } from './src/screens/RecordingScreen';
import { DoneScreen } from './src/screens/DoneScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import {
  isSessionRunning,
  useSessionStore,
} from './src/state/sessionMachine';
import { finalizeOrphanedSessions } from './src/recovery/finalizeOrphanedSessions';
import { colors, typography, spacing } from './src/design/tokens';

function App() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <StatusBar barStyle="light-content" />
        <CameraPermissionGate>
          <RecoveryGate>
            <ActiveScreen />
          </RecoveryGate>
        </CameraPermissionGate>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function ActiveScreen() {
  const appScreen = useSessionStore(s => s.appScreen);
  const sessionState = useSessionStore(s => s.sessionState);
  if (appScreen === 'library') {
    return <LibraryScreen />;
  }
  if (sessionState === 'Setup') {
    return <SetupScreen />;
  }
  if (sessionState === 'Done') {
    return <DoneScreen />;
  }
  if (isSessionRunning(sessionState)) {
    return <RecordingScreen />;
  }
  return null;
}

function RecoveryGate({ children }: { children: React.ReactNode }) {
  const [done, setDone] = useState(false);
  const [restoringCount, setRestoringCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await finalizeOrphanedSessions();
        if (!cancelled) {
          setRestoringCount(result.inspected);
          setDone(true);
        }
        console.log('[App] recovery sweep', result);
      } catch (e: any) {
        console.warn('[App] recovery sweep failed', e?.message ?? e);
        if (!cancelled) setDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!done) {
    return (
      <View style={styles.recoveryRoot}>
        <ActivityIndicator color={colors.text} size="large" />
        <Text style={styles.recoveryText}>Restoring previous Sessions…</Text>
      </View>
    );
  }
  // Silent on the happy path — no toast, no dialog. The Library shows
  // the recovered Sessions, which is the only feedback ADR-0007 wants.
  // We only log the count for visibility while we shake this out.
  if (restoringCount > 0) {
    console.log(`[App] recovery surfaced ${restoringCount} session(s)`);
  }
  return <>{children}</>;
}

function CameraPermissionGate({ children }: { children: React.ReactNode }) {
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();

  useEffect(() => {
    if (!hasPermission && canRequestPermission) {
      requestPermission();
    }
  }, [hasPermission, canRequestPermission, requestPermission]);

  if (hasPermission) {
    return <>{children}</>;
  }

  return (
    <View style={styles.center}>
      <Text style={styles.deniedTitle}>Camera permission needed</Text>
      {canRequestPermission ? (
        <Pressable style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant access</Text>
        </Pressable>
      ) : (
        <Text style={styles.deniedBody}>
          Open Settings → Active Sportz → Camera, then relaunch.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  deniedTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  deniedBody: { color: '#aaa', fontSize: 13, textAlign: 'center' },
  btn: {
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
  },
  btnText: { color: '#111', fontSize: 14, fontWeight: '700' },
  recoveryRoot: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  recoveryText: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
});

export default App;
