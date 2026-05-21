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
 * Detection is M3 — `motionScore` is exported for the UI to consume but is
 * currently held at 0; the Watching ↔ Capturing transitions it would drive
 * are not wired in M2.
 */

import { create } from 'zustand';

export type Roi = { x: number; y: number; w: number; h: number };

export type SessionState =
  | 'Setup'
  | 'Calibrating'
  | 'Watching'
  | 'Capturing'
  | 'Stopping'
  | 'Done';

export type SetupStep = 1 | 2;

export type DoneInfo = {
  masterUri: string;
  masterDurationS: number;
  sessionUri: string;
  spliceMs: number;
  outputDurationMs: number;
  sessionPhotosId: string | null;
  // Only populated in __DEV__ builds (M2–M4 convenience for visually
  // diffing Master vs Session). Null in production per ADR-0007 — the
  // Master stays in the app sandbox until M5's in-app library surfaces it.
  masterPhotosId: string | null;
};

// Per CONTEXT.md the Warm-up default is ~15s. Lifted as a constant so M4's
// adaptive baseline (ADR-0006) can swap it without grepping the codebase.
export const CALIBRATION_DURATION_MS = 15_000;

interface SessionStore {
  sessionState: SessionState;
  setupStep: SetupStep;
  roi: Roi | null;
  motionScore: number;

  masterUri: string | null;
  recordingStartedAt: number | null;
  masterDurationS: number | null;

  doneInfo: DoneInfo | null;
  error: string | null;

  setRoi: (roi: Roi | null) => void;
  setSetupStep: (step: SetupStep) => void;
  setMotionScore: (m: number) => void;

  beginCalibration: (recordingStartedAt: number) => void;
  endCalibration: () => void;
  beginStopping: (masterDurationS: number) => void;
  finishWithSuccess: (info: DoneInfo) => void;
  finishWithError: (message: string) => void;
  reset: () => void;
}

const initial = {
  sessionState: 'Setup' as SessionState,
  setupStep: 1 as SetupStep,
  roi: null,
  motionScore: 0,
  masterUri: null,
  recordingStartedAt: null,
  masterDurationS: null,
  doneInfo: null,
  error: null,
};

export const useSessionStore = create<SessionStore>(set => ({
  ...initial,

  setRoi: roi => set({ roi }),
  setSetupStep: setupStep => set({ setupStep }),
  setMotionScore: m => set({ motionScore: Math.max(0, Math.min(1, m)) }),

  beginCalibration: recordingStartedAt =>
    set({
      sessionState: 'Calibrating',
      recordingStartedAt,
      masterUri: null,
      masterDurationS: null,
      doneInfo: null,
      error: null,
    }),
  endCalibration: () => set({ sessionState: 'Watching' }),
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
