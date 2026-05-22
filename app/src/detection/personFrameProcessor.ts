/**
 * Person-detector Frame Processor — the second VisionCamera worklet,
 * mounted only when Detection Mode = `'players'` (ADR-0009).
 *
 * Throttles to `PERSON_DETECTOR_HZ` (default 2 Hz). On each emit tick
 * the worklet would:
 *   1. Preprocess the frame to the model's input format (resize +
 *      pixel-layout normalization).
 *   2. Run inference via `react-native-fast-tflite` on the CoreML
 *      delegate (ADR-0008).
 *   3. For each detected person box, compute its centroid.
 *   4. Apply centroid-in-quad against the Court ROI polygon (inlined
 *      point-in-quad math, same shape as `motionFrameProcessor.ts`).
 *   5. Emit the in-polygon count via `runOnJS`.
 *
 * The model itself is the output of the bake-off documented in ADR-0009
 * (MoveNet MultiPose Lightning / EfficientDet-Lite0 / SSDLite-MobileDetV2
 * / YOLOv8n on iPhone 12/13/14, CoreML delegate, target < 200 ms per
 * frame and recall measured on a three-gym clip set). Until that lands,
 * this module mounts a no-op worklet at the right cadence — the
 * Segmenter's `lastPersonCount` stays `null`, the player gate stays
 * open, and `'players'` Mode degrades gracefully to motion-only at
 * runtime (the "person-detector failure behaviour" footnote in ADR-0009).
 *
 * To wire in the chosen model, replace the `TODO(bake-off)` block
 * below with the real inference + centroid-in-quad pass.
 */

import { useMemo, useRef } from 'react';
import { runOnJS } from 'react-native-worklets';
import {
  CommonResolutions,
  useFrameOutput,
  type CameraFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import { PERSON_DETECTOR_HZ } from './config';
import type { Roi } from '../state/sessionMachine';

export type UsePersonFrameOutputProps = {
  roi: Roi | null;
  /**
   * Called with the most recent in-polygon person count whenever the
   * worklet runs an inference tick. The Segmenter consumes this via
   * `setPersonCount(count)` to gate Active Segment open in `'players'`
   * Mode.
   */
  onPersonCount: (count: number, atMs: number) => void;
};

export function usePersonFrameOutput({
  roi,
  onPersonCount,
}: UsePersonFrameOutputProps): CameraFrameOutput {
  const state = useMemo(
    () => ({
      // Wall-clock of the last emit, for cadence throttling.
      lastEmitAtMs: 0,
    }),
    [],
  );

  const roiRef = useRef<Roi | null>(roi);
  roiRef.current = roi;

  // Unused-on-stub variable suppression — the closure has to reference
  // onPersonCount and roiRef so they survive past the bake-off without
  // a separate edit, but until the model lands they're inert.
  void onPersonCount;

  return useFrameOutput({
    targetResolution: CommonResolutions.HD_16_9,
    // RGB plane: virtually every TFLite vision model expects a 3-channel
    // RGB input. YUV (motion's path) would force an extra colour-space
    // conversion per inference.
    pixelFormat: 'rgb',
    enablePhysicalBufferRotation: true,
    dropFramesWhileBusy: true,
    onFrame: (frame: Frame) => {
      'worklet';
      try {
        const now = Date.now();
        const minIntervalMs = 1000 / PERSON_DETECTOR_HZ;
        if (now - state.lastEmitAtMs < minIntervalMs) return;
        state.lastEmitAtMs = now;

        const currentRoi = roiRef.current;
        if (!currentRoi) return;

        // ───────────────────────────────────────────────────────────────
        // TODO(bake-off, ADR-0009): drop in the chosen TFLite model here.
        //
        // const planes = frame.getPlanes();
        // const rgb = planes[0];
        // …preprocess to model input shape…
        // const output = model.runSync([input]);
        // const boxes = parseDetections(output);
        //
        // let count = 0;
        // const c0x = currentRoi.corners[0][0];
        // const c0y = currentRoi.corners[0][1];
        // const c1x = currentRoi.corners[1][0];
        // const c1y = currentRoi.corners[1][1];
        // const c2x = currentRoi.corners[2][0];
        // const c2y = currentRoi.corners[2][1];
        // const c3x = currentRoi.corners[3][0];
        // const c3y = currentRoi.corners[3][1];
        // for (const box of boxes) {
        //   if (box.classId !== PERSON_CLASS) continue;
        //   if (box.score < CONFIDENCE_THRESHOLD) continue;
        //   // Centroid normalized to 0..1.
        //   const px = (box.x + box.w / 2);
        //   const py = (box.y + box.h / 2);
        //   const s1 = (c1x - c0x) * (py - c0y) - (c1y - c0y) * (px - c0x);
        //   const s2 = (c2x - c1x) * (py - c1y) - (c2y - c1y) * (px - c1x);
        //   const s3 = (c3x - c2x) * (py - c2y) - (c3y - c2y) * (px - c2x);
        //   const s4 = (c0x - c3x) * (py - c3y) - (c0y - c3y) * (px - c3x);
        //   const allNonNeg = s1 >= 0 && s2 >= 0 && s3 >= 0 && s4 >= 0;
        //   const allNonPos = s1 <= 0 && s2 <= 0 && s3 <= 0 && s4 <= 0;
        //   if (allNonNeg || allNonPos) count++;
        // }
        // runOnJS(onPersonCount)(count, now);
        // ───────────────────────────────────────────────────────────────

        // While the bake-off is pending, do nothing. Segmenter's
        // `lastPersonCount` stays `null`, the player gate is permissive,
        // and `'players'` Mode falls back to motion-only behaviour.
        // Reference the symbol so the bundler keeps it alive.
        void runOnJS;
      } finally {
        frame.dispose();
      }
    },
  });
}
