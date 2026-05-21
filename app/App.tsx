/**
 * Active Sportz — production app shell (M2).
 *
 * Routing is state-driven: `sessionMachine.sessionState` decides which
 * screen mounts. Setup is the entry point; Recording owns the live
 * Session; Done shows the splice result and returns to Setup via reset().
 * No navigation library is needed yet — we have three screens and one
 * linear flow.
 */

import React, { useEffect } from 'react';
import { StatusBar, StyleSheet, View, Text, Pressable } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useCameraPermission } from 'react-native-vision-camera';
import { SetupScreen } from './src/screens/SetupScreen';
import { RecordingScreen } from './src/screens/RecordingScreen';
import { DoneScreen } from './src/screens/DoneScreen';
import {
  isSessionRunning,
  useSessionStore,
} from './src/state/sessionMachine';

function App() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <StatusBar barStyle="light-content" />
        <CameraPermissionGate>
          <ActiveScreen />
        </CameraPermissionGate>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function ActiveScreen() {
  const sessionState = useSessionStore(s => s.sessionState);
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
