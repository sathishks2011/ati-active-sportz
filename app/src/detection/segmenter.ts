/**
 * Active Segment state machine — turns a continuous motion-score signal
 * into a list of coarse Active Segments (ADR-0004).
 *
 * Inputs are `(timestampMs, score)` pairs from the Frame Processor.
 * Outputs are open/close callbacks invoked at transitions; the caller
 * (RecordingScreen + sessionMachine) wires those into the Session State
 * machine and the segments buffer.
 *
 * Key behaviours (per decisions-log + ADR-0004):
 * - **Leading hold**: a single frame crossing `START_THRESHOLD` is not
 *   enough to open. Score must stay above `START_THRESHOLD` for
 *   `OPEN_HOLD_MS` (with dips into the hysteresis band tolerated) before
 *   the Segment opens. A drop below `END_THRESHOLD` during the wait
 *   resets to idle — the motion was a transient (walker, ball-retriever),
 *   not a rally.
 * - **Open** once the leading hold completes. The open-time is
 *   `firstCrossedAt - START_BACKWARD_ADJUSTMENT_S` (clamped at 0), not
 *   `now`, so the Segment captures the moment motion first crossed —
 *   the Master always has the lead-in (ADR-0007), we just adjust
 *   metadata.
 * - **Trailing hold**: once score stays under `END_THRESHOLD` for
 *   `TRAILING_HOLD_MS` (8s), the Segment closes with `endSeconds` set
 *   to *the moment motion first dropped*, not "now" 8 seconds later.
 *   Holding includes a small grace at the tail rather than padding the
 *   Session with dead time.
 * - **Re-cross during hold**: if score climbs back above
 *   `START_THRESHOLD` while a close countdown is pending, cancel the
 *   countdown — the Segment stays open through brief lulls.
 *
 * The segmenter is intentionally framework-agnostic. RecordingScreen
 * instantiates one, feeds it `onScore(...)` from the worklet's runOnJS
 * bridge, and calls `forceClose(...)` on Stop so any open Segment is
 * flushed before the splice runs.
 */

import {
  END_THRESHOLD,
  MIN_PLAYERS_IN_ROI,
  OPEN_HOLD_MS,
  START_BACKWARD_ADJUSTMENT_S,
  START_THRESHOLD,
  TRAILING_HOLD_MS,
} from './config';
import type { ActiveSegmentRecord } from '../state/sessionMachine';

/**
 * Resolved tuning knobs the Segmenter uses. Falls back to the
 * compile-time constants in `config.ts` when individual fields are
 * undefined. Pass via the constructor — the values are captured for
 * the Segmenter's lifetime so a Session is not affected by users
 * editing the Settings UI mid-Session.
 */
export type SegmenterThresholds = {
  startThreshold?: number;
  endThreshold?: number;
  openHoldMs?: number;
  trailingHoldMs?: number;
};

export type SegmenterCallbacks = {
  /**
   * Called when an Active Segment opens. Hosts should transition the
   * Session State to `Capturing` here.
   */
  onOpen: () => void;
  /**
   * Called when an Active Segment closes with the finalized
   * {@linkcode ActiveSegmentRecord}. Hosts should transition the Session
   * State to `Watching` and append to the segments buffer.
   */
  onClose: (segment: ActiveSegmentRecord) => void;
  /**
   * Returns the current "seconds-into-Master" for a given wall-clock
   * timestamp. Decoupled so the segmenter does not need to know the
   * `recorderStartedAt` reference — RecordingScreen provides it.
   */
  toMasterSeconds: (timestampMs: number) => number;
};

type SegmenterStatus =
  | { kind: 'idle' }
  | {
      kind: 'pendingOpen';
      firstCrossedAtMs: number;
      peakScore: number;
    }
  | {
      kind: 'open';
      openedAtMasterS: number;
      peakScore: number;
      pendingCloseAtMs: number | null;
    };

export class Segmenter {
  private status: SegmenterStatus = { kind: 'idle' };
  private enabled = false;
  // Latest person-count signal observed (`'players'` Mode only). Refreshed
  // independently of the motion stream — the person detector runs at a
  // lower cadence (~2 Hz vs motion's ~10 Hz emit). Set to `null` for the
  // `'motion'` Mode so the open gate behaves as if the constraint isn't
  // there (ADR-0009).
  private lastPersonCount: number | null = null;
  // Per-instance tuning. Set in the constructor from a user-overridable
  // settings snapshot; falls back to the config.ts compile-time
  // constants. Captured here so a Session keeps its values even if
  // the user touches Settings while it's running.
  private readonly startThreshold: number;
  private readonly endThreshold: number;
  private readonly openHoldMs: number;
  private readonly trailingHoldMs: number;

  constructor(
    private readonly cb: SegmenterCallbacks,
    thresholds: SegmenterThresholds = {},
  ) {
    this.startThreshold = thresholds.startThreshold ?? START_THRESHOLD;
    this.endThreshold = thresholds.endThreshold ?? END_THRESHOLD;
    this.openHoldMs = thresholds.openHoldMs ?? OPEN_HOLD_MS;
    this.trailingHoldMs = thresholds.trailingHoldMs ?? TRAILING_HOLD_MS;
  }

  /**
   * Update the most recent person-count signal. Called from the host
   * (RecordingScreen) on each `runOnJS` tick from the person-detector
   * worklet. The Segmenter does not consume this directly — `onScore`
   * reads `lastPersonCount` at open-confirmation time. Passing `null`
   * (or never calling this) keeps the open gate motion-only, which is
   * the `'motion'` Mode contract.
   */
  setPersonCount(count: number | null) {
    this.lastPersonCount = count;
  }

  // Latest device-stability signal (handheld guardrail, T28). When
  // true, the open gate is closed — the phone is being shaken /
  // walked, and any motion score is presumed to be ego-motion rather
  // than in-scene motion. Set from the RecordingScreen's IMU polling
  // loop. Defaults to false so the guardrail is opt-in (sessions
  // without IMU polling behave as before).
  private isDeviceUnstable: boolean = false;

  /**
   * Mark the device as unstable (handheld / moving) or stable (on a
   * stand). When unstable, the open path won't confirm new Active
   * Segments; in-flight Segments continue normally on the close path
   * so brief pickups don't truncate real gameplay.
   */
  setDeviceUnstable(unstable: boolean) {
    this.isDeviceUnstable = unstable;
  }

  /**
   * Toggle segmenter input. While disabled, scores are ignored — used to
   * gate the Warm-up window (`Calibrating`) so no Active Segments are
   * emitted from frames that helped establish the baseline (CONTEXT.md).
   */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled && this.status.kind !== 'idle') {
      // Drop any in-flight Segment (open or pendingOpen) if we're
      // disabled mid-flight. Realistically we only disable at Stop or
      // before Warm-up ends, and Stop is handled by `forceClose` instead —
      // but be safe.
      this.status = { kind: 'idle' };
    }
  }

  onScore(score: number, atMs: number) {
    if (!this.enabled) return;
    const status = this.status;

    if (status.kind === 'idle') {
      if (score >= this.startThreshold) {
        this.status = {
          kind: 'pendingOpen',
          firstCrossedAtMs: atMs,
          peakScore: score,
        };
      }
      return;
    }

    if (status.kind === 'pendingOpen') {
      if (score > status.peakScore) status.peakScore = score;
      // Dropped clearly below — the motion was a transient, abort the open.
      if (score < this.endThreshold) {
        this.status = { kind: 'idle' };
        return;
      }
      // Still above START *and* the leading hold has elapsed: try to
      // confirm open. In `'players'` Mode (lastPersonCount != null) we
      // also require >= MIN_PLAYERS_IN_ROI at this tick — if motion is
      // sustained but the court is empty, the Segment stays in
      // pendingOpen until either the players arrive or the motion drops
      // below the end threshold and we abort.
      if (
        score >= this.startThreshold &&
        atMs - status.firstCrossedAtMs >= this.openHoldMs &&
        this.playerGateOpen() &&
        !this.isDeviceUnstable
      ) {
        // Backdate the open timestamp to firstCrossedAtMs so callers see the
        // Segment start at the moment motion first crossed, not OPEN_HOLD_MS
        // later.
        const startMasterS = Math.max(
          0,
          this.cb.toMasterSeconds(status.firstCrossedAtMs) -
            START_BACKWARD_ADJUSTMENT_S,
        );
        this.status = {
          kind: 'open',
          openedAtMasterS: startMasterS,
          peakScore: status.peakScore,
          pendingCloseAtMs: null,
        };
        this.cb.onOpen();
      }
      // Else: still accumulating the hold, sitting in the hysteresis
      // band between END and START, or waiting for the player gate to
      // open — keep waiting.
      return;
    }

    // status.kind === 'open'
    if (score > status.peakScore) status.peakScore = score;

    if (score >= this.startThreshold) {
      // Active again — cancel any pending close.
      status.pendingCloseAtMs = null;
      return;
    }
    if (score < this.endThreshold) {
      if (status.pendingCloseAtMs == null) {
        status.pendingCloseAtMs = atMs;
      } else if (atMs - status.pendingCloseAtMs >= this.trailingHoldMs) {
        const endMasterS = this.cb.toMasterSeconds(status.pendingCloseAtMs);
        this.finalize(status.openedAtMasterS, endMasterS, status.peakScore);
      }
      return;
    }
    // Between the end and start thresholds — the hysteresis band.
    // Neither start a close nor cancel an existing one.
  }

  /**
   * Close any in-flight Segment immediately, using `atMs` as the end
   * timestamp. Invoked on Stop so the splice sees a finalized list.
   */
  forceClose(atMs: number) {
    if (this.status.kind !== 'open') return;
    const endMasterS = this.cb.toMasterSeconds(atMs);
    this.finalize(
      this.status.openedAtMasterS,
      endMasterS,
      this.status.peakScore,
    );
  }

  /**
   * Returns `true` if the player-count signal does not block opening:
   *   - `'motion'` Mode (lastPersonCount == null): always true.
   *   - `'players'` Mode: true iff the latest detector tick reported
   *     >= MIN_PLAYERS_IN_ROI inside the polygon.
   * The close path does not consult this gate (ADR-0009).
   */
  private playerGateOpen(): boolean {
    return (
      this.lastPersonCount == null ||
      this.lastPersonCount >= MIN_PLAYERS_IN_ROI
    );
  }

  private finalize(
    startSeconds: number,
    endSeconds: number,
    peakScore: number,
  ) {
    // Guard against zero/negative-length Segments — possible if the
    // backward adjustment crosses the open timestamp, or if forceClose
    // fires the same tick a Segment opened.
    if (endSeconds > startSeconds) {
      this.cb.onClose({ startSeconds, endSeconds, peakScore });
    }
    this.status = { kind: 'idle' };
  }
}
