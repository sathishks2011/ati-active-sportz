/**
 * Court ROI overlay — renders the user-drawn ROI rectangle on top of the
 * live camera preview. ROI is stored in normalized 0..1 coords on
 * `sessionMachine` and is converted to screen-space here so the rect tracks
 * window resize / rotation without the caller doing math.
 *
 * Two visual modes:
 *  - `stroke` (default): outline only — Setup Step 2 confirm, Recording
 *    Watching state, "this is where we're looking".
 *  - `capturing`: outline + warm translucent fill — Recording Capturing
 *    state, "this moment will be in the Session Recording".
 */

import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { colors } from '../design/tokens';
import type { Roi } from '../state/sessionMachine';

type Mode = 'stroke' | 'capturing';

export function CourtRoiOverlay({
  roi,
  mode = 'stroke',
}: {
  roi: Roi;
  mode?: Mode;
}) {
  const { width: W, height: H } = useWindowDimensions();
  return (
    <View
      pointerEvents="none"
      style={[
        styles.rect,
        {
          left: roi.x * W,
          top: roi.y * H,
          width: roi.w * W,
          height: roi.h * H,
        },
        mode === 'capturing' && styles.fillCapturing,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  rect: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: colors.roiStroke,
  },
  fillCapturing: { backgroundColor: colors.roiCapturingFill },
});
