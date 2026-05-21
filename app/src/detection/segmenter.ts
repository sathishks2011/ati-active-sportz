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
 * - **Open** when score crosses `START_THRESHOLD`. The open-time is
 *   `now - START_BACKWARD_ADJUSTMENT_S` (clamped at 0) so the Segment
 *   captures the moment before motion crossed — the Master always has
 *   the lead-in (ADR-0007), we just adjust metadata.
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
  START_BACKWARD_ADJUSTMENT_S,
  START_THRESHOLD,
  TRAILING_HOLD_MS,
} from './config';
import type { ActiveSegmentRecord } from '../state/sessionMachine';

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
      kind: 'open';
      openedAtMasterS: number;
      peakScore: number;
      pendingCloseAtMs: number | null;
    };

export class Segmenter {
  private status: SegmenterStatus = { kind: 'idle' };
  private enabled = false;

  constructor(private readonly cb: SegmenterCallbacks) {}

  /**
   * Toggle segmenter input. While disabled, scores are ignored — used to
   * gate the Warm-up window (`Calibrating`) so no Active Segments are
   * emitted from frames that helped establish the baseline (CONTEXT.md).
   */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled && this.status.kind === 'open') {
      // Drop the in-flight open segment if we're disabled mid-flight.
      // Realistically we only disable at Stop or before Warm-up ends,
      // and Stop is handled by `forceClose` instead — but be safe.
      this.status = { kind: 'idle' };
    }
  }

  onScore(score: number, atMs: number) {
    if (!this.enabled) return;
    const status = this.status;

    if (status.kind === 'idle') {
      if (score >= START_THRESHOLD) {
        const startMasterS = Math.max(
          0,
          this.cb.toMasterSeconds(atMs) - START_BACKWARD_ADJUSTMENT_S,
        );
        this.status = {
          kind: 'open',
          openedAtMasterS: startMasterS,
          peakScore: score,
          pendingCloseAtMs: null,
        };
        this.cb.onOpen();
      }
      return;
    }

    // status.kind === 'open'
    if (score > status.peakScore) status.peakScore = score;

    if (score >= START_THRESHOLD) {
      // Active again — cancel any pending close.
      status.pendingCloseAtMs = null;
      return;
    }
    if (score < END_THRESHOLD) {
      if (status.pendingCloseAtMs == null) {
        status.pendingCloseAtMs = atMs;
      } else if (atMs - status.pendingCloseAtMs >= TRAILING_HOLD_MS) {
        const endMasterS = this.cb.toMasterSeconds(status.pendingCloseAtMs);
        this.finalize(status.openedAtMasterS, endMasterS, status.peakScore);
      }
      return;
    }
    // Between END_THRESHOLD and START_THRESHOLD — the hysteresis band.
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
