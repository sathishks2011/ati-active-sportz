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

/**
 * Lower / upper clamp on the pinch-to-zoom factor. Devices report their
 * own min/max via `device.minZoom` and `device.maxZoom`, but binding
 * those into Setup would require plumbing the device object through to
 * the gesture state. For the MVP we clamp 1.0..5.0 — covers the
 * range a parent would reasonably need from the stands without ever
 * exceeding the wide-angle camera's optical bounds on iPhones we
 * target. A device-aware clamp is a follow-up.
 */
export const MIN_SETUP_ZOOM = 1;
export const MAX_SETUP_ZOOM = 5;

export function CameraBackdrop({ zoom }: { zoom?: number } = {}) {
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
  return (
    <Camera
      style={StyleSheet.absoluteFill}
      device={device}
      isActive
      zoom={zoom}
    />
  );
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
