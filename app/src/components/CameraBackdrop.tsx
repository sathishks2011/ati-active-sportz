/**
 * Live camera preview as a fullscreen backdrop.
 *
 * Used by the Setup screen (the ROI is drawn over a *live* preview so the
 * user is framing the actual court they'll record). The Recording screen
 * uses its own `<Camera>` element directly because it also mounts a
 * `useVideoOutput` recorder — placing both inside one `<Camera>` keeps the
 * recorder bound to the preview the user is looking at.
 *
 * Audio is explicitly off everywhere per ADR-0001 — VisionCamera defaults
 * to no audio unless an audio output is added, so no extra flag is needed.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Camera, useCameraDevices } from 'react-native-vision-camera';

export function CameraBackdrop() {
  const devices = useCameraDevices();
  const device = useMemo(
    () =>
      devices.find(d => d.position === 'back' && d.type === 'wide-angle') ??
      devices.find(d => d.position === 'back'),
    [devices],
  );
  if (!device) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.fallback]}>
        <Text style={styles.fallbackText}>No back camera available</Text>
        <Text style={styles.fallbackSub}>
          (Run on a physical iPhone — simulator has no back camera)
        </Text>
      </View>
    );
  }
  return <Camera style={StyleSheet.absoluteFill} device={device} isActive />;
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: { color: '#888', fontSize: 14 },
  fallbackSub: { color: '#555', fontSize: 11, marginTop: 4 },
});
