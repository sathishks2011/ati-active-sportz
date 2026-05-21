/**
 * Motion Frame Processor — VisionCamera worklet that turns the camera
 * feed into a continuous motion-score signal sampled inside the Court ROI.
 *
 * Approach: per-frame mean-absolute-difference on a strided sample of the
 * Y (luminance) plane, masked to the ROI in normalized coords. Y-only is
 * intentional — motion detection at this scale benefits from no chroma
 * conversion, and YUV is the camera's native format on iOS so requesting
 * it costs no pipeline overhead (per VisionCamera docs).
 *
 * The worklet:
 *   1. Pulls the Y plane via {@linkcode Frame.getPlanes}.
 *   2. Walks a coarse grid inside the ROI (every {@linkcode ROI_SAMPLE_STRIDE}
 *      pixels) accumulating |Y_now - Y_prev|.
 *   3. Normalizes mean abs diff to 0..1 (divide by 255).
 *   4. On every {@linkcode SCORE_EMIT_EVERY_N_FRAMES}-th frame, calls
 *      {@linkcode onScore} via `runOnJS` so the segmenter doesn't get
 *      flooded.
 *   5. Disposes the frame promptly (the docs warn that not disposing
 *      stalls the camera pipeline).
 *
 * State across frames (prev-sample buffer, frame counter) lives in a
 * captured-by-closure object — worklets reuse the same serialized scope
 * across invocations on a single runtime, so plain object mutations
 * persist between calls. Cross-thread sync isn't needed because the
 * segmenter reads via `runOnJS`, not via shared memory.
 *
 * Orientation: we set `enablePhysicalBufferRotation: true` so iOS rotates
 * the pixel buffer to the desired output orientation before delivery —
 * that way the ROI-in-screen-coords maps linearly to the frame buffer
 * without per-frame trig. The CPU cost is small for the resolutions we
 * use here; M7 can revisit if thermal headroom is tight.
 */

import { useMemo, useRef } from 'react';
import { runOnJS } from 'react-native-worklets';
import {
  CommonResolutions,
  useFrameOutput,
  type CameraFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import { ROI_SAMPLE_STRIDE, SCORE_EMIT_EVERY_N_FRAMES } from './config';
import type { Roi } from '../state/sessionMachine';

export type UseMotionFrameOutputProps = {
  roi: Roi | null;
  onScore: (score: number, atMs: number) => void;
};

export function useMotionFrameOutput({
  roi,
  onScore,
}: UseMotionFrameOutputProps): CameraFrameOutput {
  // State captured by the worklet closure. Mutations persist across
  // invocations within the camera-thread runtime.
  const state = useMemo(
    () => ({
      prev: null as Uint8Array | null,
      frameCount: 0,
    }),
    [],
  );

  // The worklet captures `roiRef` once via closure; we mutate `.current`
  // each render so the latest ROI reaches the camera thread without
  // re-serializing the worklet body.
  const roiRef = useRef<Roi | null>(roi);
  roiRef.current = roi;

  return useFrameOutput({
    targetResolution: CommonResolutions.HD_16_9,
    pixelFormat: 'yuv',
    enablePhysicalBufferRotation: true,
    dropFramesWhileBusy: true,
    onFrame: (frame: Frame) => {
      'worklet';
      try {
        const currentRoi = roiRef.current;
        if (!currentRoi) return;
        if (!frame.isPlanar) return;

        const planes = frame.getPlanes();
        const yPlane = planes[0];
        if (yPlane == null) return;

        const w = yPlane.width;
        const h = yPlane.height;
        const stride = yPlane.bytesPerRow;
        const buf = new Uint8Array(yPlane.getPixelBuffer());

        const x0 = Math.max(0, Math.floor(currentRoi.x * w));
        const y0 = Math.max(0, Math.floor(currentRoi.y * h));
        const x1 = Math.min(w, Math.floor((currentRoi.x + currentRoi.w) * w));
        const y1 = Math.min(h, Math.floor((currentRoi.y + currentRoi.h) * h));
        if (x1 <= x0 || y1 <= y0) return;

        // Walk the ROI on a coarse grid and pack into a flat sample
        // array. A Uint8Array keeps the prev-buffer cheap to allocate
        // and the byte-wise diff fast.
        const cols = Math.ceil((x1 - x0) / ROI_SAMPLE_STRIDE);
        const rows = Math.ceil((y1 - y0) / ROI_SAMPLE_STRIDE);
        const count = cols * rows;
        const samples = new Uint8Array(count);
        let i = 0;
        for (let y = y0; y < y1; y += ROI_SAMPLE_STRIDE) {
          const rowOffset = y * stride;
          for (let x = x0; x < x1; x += ROI_SAMPLE_STRIDE) {
            samples[i++] = buf[rowOffset + x] ?? 0;
          }
        }

        const prev = state.prev;
        if (prev != null && prev.length === samples.length) {
          let total = 0;
          for (let j = 0; j < samples.length; j++) {
            const d = samples[j] - prev[j];
            total += d < 0 ? -d : d;
          }
          const meanAbsDiff = total / samples.length;
          const score = Math.min(1, meanAbsDiff / 255);

          state.frameCount++;
          if (state.frameCount % SCORE_EMIT_EVERY_N_FRAMES === 0) {
            runOnJS(onScore)(score, Date.now());
          }
        }
        state.prev = samples;
      } finally {
        frame.dispose();
      }
    },
  });
}
