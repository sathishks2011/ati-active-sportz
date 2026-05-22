/**
 * Active Sportz — Session State store.
 *
 * The single source of truth for where a Session is in its lifecycle.
 * State names exactly match `CONTEXT.md` (Setup, Calibrating, Watching,
 * Capturing, Stopping, Done); the _Avoid_ list there is normative — do not
 * rename any of these.
 *
 * Ownership split: this store models lifecycle + Court ROI + the artifacts
 * produced by a Session (Master URI, splice result). It does *not* own the
 * camera recorder — that lives in RecordingScreen, which calls the
 * transition actions below as side-effects of recorder events.
 *
 * Detection is M3 — `motionScore` drives the motion-bar UI and the
 * Segmenter; M4 adds an adaptive baseline learned during Calibrating
 * (ADR-0006) plus a "Skip Calibration" escape hatch that falls back to
 * M3's fixed-threshold mode and is surfaced as reduced-accuracy.
 */

import { create } from 'zustand';

// A point in normalized 0..1 screen coordinates (top-left origin).
export type RoiCorner = readonly [number, number];

// Court ROI as a quadrilateral, per ADR-0010. Corners are normalized
// 0..1 screen coords ordered top-left → top-right → bottom-right → bottom-left
// (clockwise from the screen-top). The motion worklet treats "inside the
// Court ROI" as "inside this polygon" via a point-in-quad mask in its
// sampling loop; overlays render a four-segment polygon path.
//
// The quad is *assumed convex* (a real volleyball court always is from any
// reasonable camera angle). Setup validates convexity before committing.
export type Roi = {
  corners: readonly [RoiCorner, RoiCorner, RoiCorner, RoiCorner];
};

export type SessionState =
  | 'Setup'
  | 'Calibrating'
  | 'Watching'
  | 'Capturing'
  | 'Stopping'
  | 'Done';

export type SetupStep = 1 | 2;

// Top-level "screen" routing dimension orthogonal to `sessionState`.
// 'dashboard' is the app's home — every cold launch lands here, and
// the user has to tap a CTA to enter the camera-capable Session flow.
// The other destinations are siblings reachable from the drawer.
export type AppScreen =
  | 'dashboard'
  | 'session'
  | 'library'
  | 'settings'
  | 'about';

export type DoneInfo = {
  masterUri: string;
  masterDurationS: number;
  // Null when no Session Recording was produced — either no Active Segments
  // were captured, or the splice failed, or the recorder errored mid-Session
  // and we recovered just the Master. The Done screen renders a "Master
  // preserved" state in those cases instead of the regular "Saved to Photos"
  // success.
  sessionUri: string | null;
  spliceMs: number;
  // Length of the Session Recording in milliseconds. Zero when sessionUri
  // is null (no splice ran).
  outputDurationMs: number;
  sessionPhotosId: string | null;
  // Only populated in __DEV__ builds (M2–M4 convenience for visually
  // diffing Master vs Session). Null in production per ADR-0007 — the
  // Master stays in the app sandbox until M5's in-app library surfaces it.
  masterPhotosId: string | null;
  segments: ActiveSegmentRecord[];
  // True if this Session ran with the M3 fixed-threshold fallback rather
  // than M4's adaptive baseline — surfaced on Done as a reminder that
  // accuracy may be lower (ADR-0006). Set when the user taps Skip
  // Calibration during the Warm-up phase.
  usedFixedThreshold: boolean;
  // Set when the Session was recovered rather than finished cleanly:
  // recorder errored, splice failed, or no motion was detected. The
  // string is rendered prominently on the Done screen so the user
  // knows what happened *and* sees that the Master was preserved.
  recoveryNote: string | null;
};

// An Active Segment as the detector emitted it. Carries diagnostics
// (peakScore) beyond the bare start/end the Splicer needs, so M3/M4 tuning
// has the data without re-running a Session. M5's SQLite schema is the
// long-term home for these.
export type ActiveSegmentRecord = {
  startSeconds: number;
  endSeconds: number;
  peakScore: number;
};

// Per CONTEXT.md the Warm-up default is ~15s. Lifted as a constant so M4's
// adaptive baseline (ADR-0006) can swap it without grepping the codebase.
export const CALIBRATION_DURATION_MS = 15_000;

interface SessionStore {
  appScreen: AppScreen;
  sessionState: SessionState;
  setupStep: SetupStep;
  roi: Roi | null;
  // Camera zoom factor chosen on Setup Step 1 via pinch-to-zoom
  // (decisions-log: "Pinch-to-zoom at Setup"). Frozen at Auto Record
  // and applied as the `zoom` prop on both the Setup preview and the
  // RecordingScreen Camera so the worklet sees exactly what the user
  // framed. Defaults to 1.0 (no zoom) and survives Step1↔Step2
  // navigation. Not persisted across Sessions.
  setupZoom: number;
  motionScore: number;

  masterUri: string | null;
  // Wall-clock at "Auto Record" tap (Setup → Calibrating). Used for the
  // Master duration we display on Done — includes the small lead-in
  // between tap and the camera actually rolling.
  recordingStartedAt: number | null;
  // Wall-clock at the moment VisionCamera signalled the recorder is
  // actually writing frames (M3 needs this as the time origin for
  // Active Segment offsets — segment seconds are seconds-into-Master).
  recorderStartedAt: number | null;
  masterDurationS: number | null;

  segments: ActiveSegmentRecord[];
  // When true, the detector runs in the M3 fixed-threshold fallback —
  // no per-pixel baseline, score is plain frame-to-frame Y diff.
  // Toggled by the "Skip Calibration" button during Warm-up (ADR-0006).
  useFixedThreshold: boolean;
  // DB primary key of the currently in-flight `sessions` row (M5,
  // ADR-0007). Set when Setup opens a row at "Auto Record"; cleared on
  // reset(). RecordingScreen reads it to attach the Master URI, append
  // segments, and finalize the row.
  currentSessionId: number | null;
  // DB id the user tapped on the Dashboard's Recent Sessions list.
  // Library reads this on mount and highlights the matching card.
  // Cleared once the highlight has been shown so re-visits don't keep
  // re-highlighting a stale row.
  focusedSessionId: number | null;

  doneInfo: DoneInfo | null;
  error: string | null;

  setAppScreen: (screen: AppScreen) => void;
  setFocusedSessionId: (id: number | null) => void;
  setRoi: (roi: Roi | null) => void;
  setSetupZoom: (zoom: number) => void;
  setSetupStep: (step: SetupStep) => void;
  setMotionScore: (m: number) => void;

  beginCalibration: (recordingStartedAt: number, sessionId: number) => void;
  endCalibration: () => void;
  // Tap-target for the in-Warm-up "Skip Calibration" button. Transitions
  // straight to Watching and pins the detector to fixed-threshold mode
  // for the rest of the Session (no usable baseline was learned).
  skipCalibration: () => void;
  markRecorderStarted: (at: number) => void;
  // Segmenter callbacks: open transitions Watching → Capturing; close
  // transitions Capturing → Watching and appends to `segments`. The
  // segmenter (src/detection/segmenter.ts) owns the open/close logic;
  // these actions just thread the result through the store so the UI and
  // the splice both see it.
  openActiveSegment: () => void;
  closeActiveSegment: (segment: ActiveSegmentRecord) => void;
  beginStopping: (masterDurationS: number) => void;
  finishWithSuccess: (info: DoneInfo) => void;
  finishWithError: (message: string) => void;
  reset: () => void;
}

const initial = {
  appScreen: 'dashboard' as AppScreen,
  sessionState: 'Setup' as SessionState,
  setupStep: 1 as SetupStep,
  roi: null,
  setupZoom: 1,
  motionScore: 0,
  masterUri: null,
  recordingStartedAt: null,
  recorderStartedAt: null,
  masterDurationS: null,
  segments: [] as ActiveSegmentRecord[],
  useFixedThreshold: false,
  currentSessionId: null,
  focusedSessionId: null,
  doneInfo: null,
  error: null,
};

export const useSessionStore = create<SessionStore>(set => ({
  ...initial,

  setAppScreen: appScreen => set({ appScreen }),
  setFocusedSessionId: focusedSessionId => set({ focusedSessionId }),
  setRoi: roi => set({ roi }),
  setSetupZoom: setupZoom => set({ setupZoom }),
  setSetupStep: setupStep => set({ setupStep }),
  setMotionScore: m => set({ motionScore: Math.max(0, Math.min(1, m)) }),

  beginCalibration: (recordingStartedAt, sessionId) =>
    set({
      sessionState: 'Calibrating',
      recordingStartedAt,
      recorderStartedAt: null,
      masterUri: null,
      masterDurationS: null,
      segments: [],
      useFixedThreshold: false,
      currentSessionId: sessionId,
      doneInfo: null,
      error: null,
    }),
  endCalibration: () => set({ sessionState: 'Watching' }),
  skipCalibration: () =>
    set({ sessionState: 'Watching', useFixedThreshold: true }),
  markRecorderStarted: at => set({ recorderStartedAt: at }),
  openActiveSegment: () => set({ sessionState: 'Capturing' }),
  closeActiveSegment: segment =>
    set(state => ({
      sessionState: 'Watching',
      segments: [...state.segments, segment],
    })),
  beginStopping: masterDurationS =>
    set({ sessionState: 'Stopping', masterDurationS }),
  finishWithSuccess: info =>
    set({
      sessionState: 'Done',
      doneInfo: info,
      masterUri: info.masterUri,
    }),
  // Errors during Stopping (recorder, splice, Photos save) need to land the
  // user on the Done screen with the message visible — otherwise the
  // Stopping spinner stays up forever with no way out. Surfacing on Done
  // also keeps the "New Session" reset button reachable.
  finishWithError: message => set({ sessionState: 'Done', error: message }),
  reset: () => set({ ...initial }),
}));

// "Session is running" gates the Stop button vs the Auto-Record button —
// once the user has tapped Auto Record and before Done lands.
export function isSessionRunning(state: SessionState): boolean {
  return (
    state === 'Calibrating' ||
    state === 'Watching' ||
    state === 'Capturing' ||
    state === 'Stopping'
  );
}
