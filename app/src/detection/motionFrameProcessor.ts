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
 *
 * Court ROI is a quadrilateral (ADR-0010). Sampling iterates the
 * polygon's axis-aligned bounding box, then applies a point-in-quad
 * mask (four cross-product signs) per sample. Masked-out samples do
 * not contribute to the warm-up baseline or the per-frame diff. The
 * mask is computed once when the per-ROI accumulator buffers are
 * (re-)allocated — ROI is locked at Auto Record so the mask is stable
 * for the Session. Keep the math here in sync with `state/roi.ts`'s
 * `pointInQuad` (worklets can't import JS helpers).
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
      // Polygon mask: 1 if the sample at that index falls inside the
      // user's Court ROI quadrilateral, else 0. Computed once per
      // accumulator (re-)allocation. `maskCount` is the number of
      // 1s in the mask — used as the score-normalization divisor so
      // the score remains motion-per-in-court-sample regardless of
      // how much of the frame the polygon covers.
      mask: null as Uint8Array | null,
      maskCount: 0,
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

        // Polygon corners in normalized coords (TL, TR, BR, BL by ADR-0010).
        const c0x = currentRoi.corners[0][0];
        const c0y = currentRoi.corners[0][1];
        const c1x = currentRoi.corners[1][0];
        const c1y = currentRoi.corners[1][1];
        const c2x = currentRoi.corners[2][0];
        const c2y = currentRoi.corners[2][1];
        const c3x = currentRoi.corners[3][0];
        const c3y = currentRoi.corners[3][1];

        // Axis-aligned bounding box of the polygon, in pixel coords.
        const minNx = Math.min(c0x, c1x, c2x, c3x);
        const minNy = Math.min(c0y, c1y, c2y, c3y);
        const maxNx = Math.max(c0x, c1x, c2x, c3x);
        const maxNy = Math.max(c0y, c1y, c2y, c3y);
        const x0 = Math.max(0, Math.floor(minNx * w));
        const y0 = Math.max(0, Math.floor(minNy * h));
        const x1 = Math.min(w, Math.floor(maxNx * w));
        const y1 = Math.min(h, Math.floor(maxNy * h));
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
        // The polygon mask is computed alongside since its shape is
        // entirely determined by the ROI corners + bounding box.
        if (state.sum == null || state.sum.length !== count) {
          state.sum = new Float32Array(count);
          state.sumCount = 0;
          state.baseline = null;
          const mask = new Uint8Array(count);
          let masked = 0;
          let k = 0;
          for (let y = y0; y < y1; y += ROI_SAMPLE_STRIDE) {
            // Normalize this row's y once.
            const py = h > 0 ? y / h : 0;
            for (let x = x0; x < x1; x += ROI_SAMPLE_STRIDE) {
              const px = w > 0 ? x / w : 0;
              // Four cross-products against consecutive edges of the
              // polygon. A convex polygon contains the point iff all
              // signs agree (zeros tolerated as on-edge).
              const s1 = (c1x - c0x) * (py - c0y) - (c1y - c0y) * (px - c0x);
              const s2 = (c2x - c1x) * (py - c1y) - (c2y - c1y) * (px - c1x);
              const s3 = (c3x - c2x) * (py - c2y) - (c3y - c2y) * (px - c2x);
              const s4 = (c0x - c3x) * (py - c3y) - (c0y - c3y) * (px - c3x);
              const allNonNeg =
                s1 >= 0 && s2 >= 0 && s3 >= 0 && s4 >= 0;
              const allNonPos =
                s1 <= 0 && s2 <= 0 && s3 <= 0 && s4 <= 0;
              if (allNonNeg || allNonPos) {
                mask[k] = 1;
                masked++;
              } else {
                mask[k] = 0;
              }
              k++;
            }
          }
          state.mask = mask;
          state.maskCount = masked;
        }
        const mask = state.mask;
        const maskCount = state.maskCount;
        // Degenerate ROI (no in-quad samples) — skip this frame quietly.
        if (mask == null || maskCount === 0) return;

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
        // every available sample feeding the mean. Only in-quad
        // samples contribute (mask gate).
        if (currentPhase === 'warmup' && state.sum != null) {
          const sum = state.sum;
          for (let j = 0; j < count; j++) {
            if (mask[j] === 1) sum[j] += samples[j];
          }
          state.sumCount++;
        }

        // Score depends on phase:
        //   - detect: deviation from frozen baseline.
        //   - warmup / fixed: classic frame-to-frame Y diff.
        // The segmenter is gated off during warmup by the host, so the
        // diff value there only drives the motion-bar UI. Normalize by
        // `maskCount` (in-quad samples) rather than `count` (bbox
        // samples) so the score is invariant to how much of the frame
        // the polygon happens to cover.
        let score: number | null = null;
        if (currentPhase === 'detect' && state.baseline != null) {
          const baseline = state.baseline;
          let total = 0;
          for (let j = 0; j < count; j++) {
            if (mask[j] === 0) continue;
            const d = samples[j] - baseline[j];
            total += d < 0 ? -d : d;
          }
          score = Math.min(1, total / maskCount / 255);
        } else {
          const prev = state.prev;
          if (prev != null && prev.length === count) {
            let total = 0;
            for (let j = 0; j < count; j++) {
              if (mask[j] === 0) continue;
              const d = samples[j] - prev[j];
              total += d < 0 ? -d : d;
            }
            score = Math.min(1, total / maskCount / 255);
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
