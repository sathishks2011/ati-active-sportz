/**
 * Court ROI overlay — renders the user-defined Court polygon on top of the
 * live camera preview. The ROI is stored as four normalized 0..1 corners
 * (ADR-0010); this component converts them to screen-space via the current
 * window dimensions so the polygon tracks resize / rotation without callers
 * doing math.
 *
 * Rendering strategy: four absolutely-positioned, rotated thin `View`s — one
 * per edge of the polygon. No `react-native-svg` dependency. The "capturing"
 * mode bumps the stroke color and width rather than filling the polygon —
 * filling a quadrilateral without SVG would require triangle decomposition;
 * a heavier stroke + glow reads just as cleanly on the live preview.
 *
 * Two visual modes:
 *  - `stroke` (default): outline only — Setup Step 2 confirm, Recording
 *    Watching state, "this is where we're looking".
 *  - `capturing`: heavier warm-toned outline — Recording Capturing state,
 *    "this moment will be in the Session Recording".
 */

import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { colors } from '../design/tokens';
import type { Roi } from '../state/sessionMachine';

type Mode = 'stroke' | 'capturing';

const STROKE_WIDTH = 2;
const STROKE_WIDTH_CAPTURING = 3;

export function CourtRoiOverlay({
  roi,
  mode = 'stroke',
}: {
  roi: Roi;
  mode?: Mode;
}) {
  const { width: W, height: H } = useWindowDimensions();
  const strokeColor =
    mode === 'capturing' ? colors.roiCapturingStroke : colors.roiStroke;
  const strokeWidth =
    mode === 'capturing' ? STROKE_WIDTH_CAPTURING : STROKE_WIDTH;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {roi.corners.map((corner, i) => {
        const next = roi.corners[(i + 1) % 4];
        return (
          <Edge
            key={i}
            x1={corner[0] * W}
            y1={corner[1] * H}
            x2={next[0] * W}
            y2={next[1] * H}
            color={strokeColor}
            thickness={strokeWidth}
          />
        );
      })}
    </View>
  );
}

function Edge({
  x1,
  y1,
  x2,
  y2,
  color,
  thickness,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: number;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const angleRad = Math.atan2(dy, dx);
  return (
    <View
      style={{
        position: 'absolute',
        left: x1,
        top: y1 - thickness / 2,
        width: length,
        height: thickness,
        backgroundColor: color,
        transform: [{ rotate: `${angleRad}rad` }],
        transformOrigin: '0% 50%',
      }}
    />
  );
}
