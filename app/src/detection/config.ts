/**
 * Detection tuning constants — M3 (fixed-threshold motion).
 *
 * These are the dials we expect to retune. They live here so the segmenter,
 * the frame processor, and any debug overlays read from one place — and so
 * a future M4 (adaptive baseline per ADR-0006) can swap the thresholds for
 * a computed pair without touching the segmenter logic.
 *
 * The numbers below are first-pass guesses chosen for a typical youth gym:
 * - mean abs Y-plane diff at "no motion in ROI" is dominated by sensor
 *   noise — empirically a few units on 0..255, i.e. ~0.01..0.02 normalized.
 * - a player crossing the ROI moves a meaningful percentage of pixels by
 *   tens of units — pushes the mean toward ~0.05..0.15.
 * Expect to tune in M3 on-device by watching the live motion-bar histogram
 * before moving to M4's adaptive replacement.
 */

// ─── Segmenter thresholds (motion score in 0..1) ─────────────────────────────

// Score must exceed this to OPEN a new Active Segment. Set above the noise
// floor of a static ROI but below where a single player's movement lands.
export const START_THRESHOLD = 0.04;

// Score must drop below this to begin closing an Active Segment. Set under
// START_THRESHOLD to provide hysteresis — once playing, brief lulls (~1s of
// quiet between rallies) should not start a close countdown if any incidental
// motion crosses START.
export const END_THRESHOLD = 0.025;

// Once score stays under END_THRESHOLD for this long, the Segment closes.
// 8s per decisions-log — chosen so 10–15s walks between rallies *do* close
// the Segment (supporting "coarse but not too coarse", ADR-0004) while
// brief mid-rally pauses do not.
export const TRAILING_HOLD_MS = 8_000;

// When closing, subtract this from the open-time so the Segment's start
// captures the moment-before-motion-crossed-threshold. Per decisions-log:
// pre-roll-as-ring-buffer is obsolete under ADR-0007 because the Master
// always has the lead-in; we just adjust the metadata timestamp backward.
export const START_BACKWARD_ADJUSTMENT_S = 2;

// ─── Frame Processor sampling ────────────────────────────────────────────────

// Inside the ROI we sample a coarse grid rather than every pixel — motion
// detection at this scale doesn't benefit from full resolution and a tight
// per-frame budget is essential. We hop in both axes by this many pixels
// while accumulating mean abs diff over the Y plane.
export const ROI_SAMPLE_STRIDE = 4;

// Throttle JS-side notifications: the worklet runs at the camera frame rate
// (~30 fps on iOS). Emit a score to JS every Nth processed frame so the
// segmenter and UI update at a manageable cadence without blocking the
// camera thread on bridge calls.
export const SCORE_EMIT_EVERY_N_FRAMES = 3;
