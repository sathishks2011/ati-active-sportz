/**
 * Active Sportz — production app shell.
 *
 * Routing is driven by two store fields:
 *   - `appScreen`: 'session' | 'library' | 'settings' | 'about'. The
 *     drawer destinations are siblings to the Setup/Recording/Done
 *     flow.
 *   - `sessionState`: when `appScreen === 'session'`, decides which
 *     of Setup / Recording / Done to mount.
 *
 * On launch: a brief branded splash overlays everything while the
 * M5 crash-recovery sweep runs. The splash dismisses when both
 * elapsed >= 1.5s AND the sweep has finished — so the user always
 * sees the wordmark for at least one beat and the boot feels like
 * one continuous animation rather than a fight between loaders.
 */

import React, { useEffect, useState } from 'react';
import {
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
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AboutScreen } from './src/screens/AboutScreen';
import { SplashScreen } from './src/screens/SplashScreen';
import {
  isSessionRunning,
  useSessionStore,
} from './src/state/sessionMachine';
import { finalizeOrphanedSessions } from './src/recovery/finalizeOrphanedSessions';

const SPLASH_MIN_MS = 1_500;

function App() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <StatusBar barStyle="light-content" />
        <CameraPermissionGate>
          <BootGate>
            <ActiveScreen />
          </BootGate>
        </CameraPermissionGate>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function ActiveScreen() {
  const appScreen = useSessionStore(s => s.appScreen);
  const sessionState = useSessionStore(s => s.sessionState);
  if (appScreen === 'library') return <LibraryScreen />;
  if (appScreen === 'settings') return <SettingsScreen />;
  if (appScreen === 'about') return <AboutScreen />;
  if (sessionState === 'Setup') return <SetupScreen />;
  if (sessionState === 'Done') return <DoneScreen />;
  if (isSessionRunning(sessionState)) return <RecordingScreen />;
  return null;
}

/**
 * Holds the splash until (a) the SPLASH_MIN_MS beat has elapsed AND
 * (b) the recovery sweep has finished. Either alone would feel wrong
 * — a sub-second splash flashes weirdly on cold start, and dismissing
 * before recovery means we'd briefly land on Setup before the
 * sweep silently rewrites state.
 */
function BootGate({ children }: { children: React.ReactNode }) {
  const [timeElapsed, setTimeElapsed] = useState(false);
  const [recoveryDone, setRecoveryDone] = useState(false);
  const [recoveryNote, setRecoveryNote] = useState<string | undefined>(
    undefined,
  );

  useEffect(() => {
    const t = setTimeout(() => setTimeElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await finalizeOrphanedSessions();
        if (cancelled) return;
        if (result.inspected > 0) {
          setRecoveryNote(
            `Restored ${result.finalized + result.abandoned} previous Session${
              result.inspected === 1 ? '' : 's'
            }.`,
          );
        }
        setRecoveryDone(true);
      } catch (e: any) {
        console.warn('[App] recovery sweep failed', e?.message ?? e);
        if (!cancelled) setRecoveryDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = timeElapsed && recoveryDone;
  return (
    <>
      {children}
      {!ready && (
        <View style={StyleSheet.absoluteFill}>
          <SplashScreen subText={recoveryNote} />
        </View>
      )}
    </>
  );
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
});

export default App;
