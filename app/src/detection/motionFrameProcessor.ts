/**
 * Motion Frame Processor — VisionCamera worklet that turns the camera
 * feed into a continuous motion-score signal sampled inside the Court ROI.
 *
 * M4 (ADR-0006) replaces M3's bare frame-to-frame Y-diff with a phased
 * detector:
 *   - `warmup`: accumulate a per-sample baseline mean from frames inside
 *     the ROI. The emitted score is still frame-to-frame diff — that
 *     keeps the motion-bar UI responsive during Calibrating so the user
 *     sees the detector is alive, while the segmenter is held off until
 *     Watching (see RecordingScreen).
 *   - `detect`: freeze the baseline on the first detect-phase frame
 *     (`baseline[i] = sum[i] / count`) and switch the emitted score to
 *     mean |sample[i] - baseline[i]| / 255 — deviation from "what idle
 *     looked like in this exact gym/lighting".
 *   - `fixed`: the M3 fallback the "Skip Calibration" button selects.
 *     Pure frame-to-frame diff start to finish; no baseline.
 *
 * Y-only and YUV are intentional — luminance carries enough signal for
 * motion at this scale and YUV is the camera's native iOS format, so
 * the pipeline pays no chroma-conversion cost.
 *
 * State across frames (prev sample buffer, baseline sum/count, phase
 * memory) lives in a useMemo-stable object captured by the worklet
 * closure — same-runtime mutation persists between invocations. No
 * Synchronizable needed because the segmenter receives scores via
 * `runOnJS`, not via shared memory.
 *
 * Orientation: `enablePhysicalBufferRotation: true` makes the buffer
 * arrive already rotated to the desired output orientation, so the
 * screen-normalized ROI maps linearly to frame coords without per-frame
 * trig. The CPU cost is small at this resolution; M7 may revisit if
 * thermal headroom gets tight.
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

export type MotionPhase = 'warmup' | 'detect' | 'fixed';

export type UseMotionFrameOutputProps = {
  roi: Roi | null;
  phase: MotionPhase;
  onScore: (score: number, atMs: number) => void;
};

export function useMotionFrameOutput({
  roi,
  phase,
  onScore,
}: UseMotionFrameOutputProps): CameraFrameOutput {
  // State captured by the worklet closure. Mutations persist across
  // invocations within the camera-thread runtime.
  const state = useMemo(
    () => ({
      prev: null as Uint8Array | null,
      // Running baseline accumulators (warm-up phase only). Allocated
      // lazily once we know the sample count.
      sum: null as Float32Array | null,
      sumCount: 0,
      // Committed baseline (frozen at the warmup→detect transition).
      baseline: null as Float32Array | null,
      // Phase we last processed a frame in — used to detect the
      // warmup→detect boundary inside the worklet so the baseline
      // commit happens on the right frame.
      lastPhase: null as MotionPhase | null,
      frameCount: 0,
    }),
    [],
  );

  // The worklet captures these refs once via closure; we mutate
  // `.current` each render so the latest ROI / phase reaches the
  // camera thread without re-serializing the worklet body.
  const roiRef = useRef<Roi | null>(roi);
  roiRef.current = roi;
  const phaseRef = useRef<MotionPhase>(phase);
  phaseRef.current = phase;

  return useFrameOutput({
    targetResolution: CommonResolutions.HD_16_9,
    pixelFormat: 'yuv',
    enablePhysicalBufferRotation: true,
    dropFramesWhileBusy: true,
    onFrame: (frame: Frame) => {
      'worklet';
      try {
        const currentRoi = roiRef.current;
        const currentPhase = phaseRef.current;
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

        // Allocate / re-allocate the baseline accumulators if this is
        // our first frame or the sample count changed (shouldn't happen
        // mid-session — ROI is locked at Auto Record — but be safe).
        if (state.sum == null || state.sum.length !== count) {
          state.sum = new Float32Array(count);
          state.sumCount = 0;
          state.baseline = null;
        }

        // On the warmup→detect boundary, freeze the baseline. We use
        // sum/count if Warm-up gathered enough frames; otherwise we
        // fall back to mirroring the current sample (so the first
        // detect frame scores ~0 rather than spiking).
        if (
          state.lastPhase === 'warmup' &&
          currentPhase === 'detect' &&
          state.baseline == null
        ) {
          const committed = new Float32Array(count);
          if (state.sumCount > 0) {
            for (let j = 0; j < count; j++) {
              committed[j] = state.sum[j] / state.sumCount;
            }
          } else {
            for (let j = 0; j < count; j++) committed[j] = samples[j];
          }
          state.baseline = committed;
        }

        // Accumulate baseline during warmup. We do this *every* frame
        // (no stride throttling here) — Warm-up is short and we want
        // every available sample feeding the mean.
        if (currentPhase === 'warmup' && state.sum != null) {
          const sum = state.sum;
          for (let j = 0; j < count; j++) sum[j] += samples[j];
          state.sumCount++;
        }

        // Score depends on phase:
        //   - detect: deviation from frozen baseline.
        //   - warmup / fixed: classic frame-to-frame Y diff.
        // The segmenter is gated off during warmup by the host, so the
        // diff value there only drives the motion-bar UI.
        let score: number | null = null;
        if (currentPhase === 'detect' && state.baseline != null) {
          const baseline = state.baseline;
          let total = 0;
          for (let j = 0; j < count; j++) {
            const d = samples[j] - baseline[j];
            total += d < 0 ? -d : d;
          }
          score = Math.min(1, total / count / 255);
        } else {
          const prev = state.prev;
          if (prev != null && prev.length === count) {
            let total = 0;
            for (let j = 0; j < count; j++) {
              const d = samples[j] - prev[j];
              total += d < 0 ? -d : d;
            }
            score = Math.min(1, total / count / 255);
          }
        }

        if (score != null) {
          state.frameCount++;
          if (state.frameCount % SCORE_EMIT_EVERY_N_FRAMES === 0) {
            runOnJS(onScore)(score, Date.now());
          }
        }

        state.prev = samples;
        state.lastPhase = currentPhase;
      } finally {
        frame.dispose();
      }
    },
  });
}
