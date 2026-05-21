/**
 * Active Sportz — production app shell.
 *
 * Routing is driven by two store fields:
 *   - `appScreen`: 'dashboard' | 'session' | 'library' | 'settings' |
 *     'about'. Cold launches always land on 'dashboard' — the
 *     camera-bearing Session flow only mounts after the user taps
 *     "Start Recording" there.
 *   - `sessionState`: when `appScreen === 'session'`, decides which
 *     of Setup / Recording / Done to mount.
 *
 * Camera permission is no longer requested at app launch. The
 * Dashboard works without it, and the prompt happens inside the
 * Dashboard's Start Recording handler so first-time users see the
 * brand and a clear CTA before any OS modal.
 *
 * On launch: a brief branded splash overlays everything while the
 * M5 crash-recovery sweep runs. The splash dismisses when both
 * elapsed >= 1.5s AND the sweep has finished — so the user always
 * sees the wordmark for at least one beat and the boot feels like
 * one continuous animation rather than a fight between loaders.
 */

import React, { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DashboardScreen } from './src/screens/DashboardScreen';
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
        <BootGate>
          <ActiveScreen />
        </BootGate>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function ActiveScreen() {
  const appScreen = useSessionStore(s => s.appScreen);
  const sessionState = useSessionStore(s => s.sessionState);
  if (appScreen === 'dashboard') return <DashboardScreen />;
  if (appScreen === 'library') return <LibraryScreen />;
  if (appScreen === 'settings') return <SettingsScreen />;
  if (appScreen === 'about') return <AboutScreen />;
  // appScreen === 'session'
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
});

export default App;
