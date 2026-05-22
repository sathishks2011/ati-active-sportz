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
//
// Tuned 2026-05-21 from field-test data: the previous 0.04 was calibrated
// for game-scale motion (multiple players moving fast in a small slice of
// the polygon). Single-person room-scale tests produced mean diff ~0.02–
// 0.03 — below the old START, so the detector never fired. Lowered to
// 0.02 so single-person validation works; the 1.5s leading-hold
// (OPEN_HOLD_MS) still rejects transient noise spikes near the noise
// floor (~0.005–0.015 normalized).
export const START_THRESHOLD = 0.02;

// Score must drop below this to begin closing an Active Segment. Set under
// START_THRESHOLD to provide hysteresis — once playing, brief lulls (~1s of
// quiet between rallies) should not start a close countdown if any incidental
// motion crosses START.
export const END_THRESHOLD = 0.012;

// Score must stay above START_THRESHOLD for this long before an Active
// Segment opens. Mirrors TRAILING_HOLD_MS on the open side — a single
// transient (someone walking through the ROI, a ball-retriever) is no
// longer enough to flip Watching→Capturing. Reset to idle if score
// drops below END_THRESHOLD during the wait (i.e. the motion was a
// transient, not a sustained rally).
export const OPEN_HOLD_MS = 1_500;

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

// ─── 'players' Mode gates (ADR-0009) ─────────────────────────────────────────

// Minimum number of detected people inside the Court ROI required to open
// an Active Segment when Mode = 'players'. The close path does *not* use
// this gate (ADR-0009). Initial guess: 3 — enough to reject 1–2-person
// non-game activity (a coach demonstrating, a ball-retriever, a referee
// fixing the net), low enough to tolerate per-frame detector misses
// during real gameplay. Retune from field-test logs.
export const MIN_PLAYERS_IN_ROI = 3;

// Cadence of the person-detector worklet, in Hz. The motion worklet runs
// at the camera frame rate (~30 fps) and emits to JS at ~10 Hz; the
// person detector is materially heavier per inference, so we run it at
// 2 Hz. Still much faster than the 1.5s OPEN_HOLD_MS leading hold, so
// the open-confirmation tick will always see a fresh-enough count.
export const PERSON_DETECTOR_HZ = 2;

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
