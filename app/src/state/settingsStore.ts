/**
 * Persistent user preferences (M7+ polish).
 *
 * Distinct from `sessionMachine` — that store holds *Session* lifecycle
 * state which resets between Sessions. This store holds preferences
 * that live across app launches. Backed by MMKV so writes are
 * synchronous and durable; loaded on module import so screens that
 * read from it never have to wait for hydration.
 *
 * v1 surface is intentionally small. Anything that crosses the bar of
 * "the user wants to change this and the default isn't great for
 * everyone" can be added here without restructuring.
 */

import { createMMKV } from 'react-native-mmkv';
import { create } from 'zustand';
import type { DetectionMode } from '../persistence/sessionRepo';
import {
  END_THRESHOLD,
  OPEN_HOLD_MS,
  START_THRESHOLD,
  TRAILING_HOLD_MS,
} from '../detection/config';

const mmkv = createMMKV();
const KEY = 'settings:v1';

type PersistedSettings = {
  /**
   * If true, "Auto Record" skips the Warm-up phase by default — i.e.,
   * acts as if the user tapped "Skip Warm-up" the moment Calibrating
   * started. The detector runs in M3's fixed-threshold fallback for
   * the whole Session.
   *
   * Useful for users who arrive mid-match (so the ROI has motion in
   * it from the start and a learned baseline would be wrong anyway).
   * Surfaced as a toggle in Settings; default off.
   */
  alwaysSkipWarmup: boolean;
  /**
   * Per-Session Detection Mode (ADR-0009). Internal identifier; the UI
   * labels these as `Smart` (`'motion'`) and `Enhanced` (`'players'`)
   * via the `labelForMode` helper in the screens layer. Default
   * `'motion'` until field-test data justifies flipping (decisions-log:
   * "Detection Mode names").
   */
  detectionMode: DetectionMode;
  /**
   * User overrides for the segmenter's threshold + hold tuning knobs.
   * `null` (default) means "use the compile-time defaults from
   * config.ts"; a number means "override". The Segmenter constructor
   * accepts a resolved thresholds object so a Session uses whatever
   * was in effect when Auto Record was tapped (changing Settings
   * mid-Session does not change the in-flight pipeline).
   *
   * Exposed in Settings as +/- steppers per knob with a "reset to
   * default" link. The defaults track config.ts — when we re-tune
   * the constants there, users who never customised get the new
   * defaults automatically because their override stays null.
   */
  userStartThreshold: number | null;
  userEndThreshold: number | null;
  userOpenHoldMs: number | null;
  userTrailingHoldMs: number | null;
};

const defaults: PersistedSettings = {
  alwaysSkipWarmup: false,
  detectionMode: 'motion',
  userStartThreshold: null,
  userEndThreshold: null,
  userOpenHoldMs: null,
  userTrailingHoldMs: null,
};

function load(): PersistedSettings {
  const raw = mmkv.getString(KEY);
  if (raw == null) return defaults;
  try {
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function save(next: PersistedSettings) {
  mmkv.set(KEY, JSON.stringify(next));
}

interface SettingsStore extends PersistedSettings {
  setAlwaysSkipWarmup: (value: boolean) => void;
  setDetectionMode: (mode: DetectionMode) => void;
  setUserStartThreshold: (value: number | null) => void;
  setUserEndThreshold: (value: number | null) => void;
  setUserOpenHoldMs: (value: number | null) => void;
  setUserTrailingHoldMs: (value: number | null) => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...load(),
  setAlwaysSkipWarmup: alwaysSkipWarmup => {
    set({ alwaysSkipWarmup });
    save({ ...get(), alwaysSkipWarmup });
  },
  setDetectionMode: detectionMode => {
    set({ detectionMode });
    save({ ...get(), detectionMode });
  },
  setUserStartThreshold: userStartThreshold => {
    set({ userStartThreshold });
    save({ ...get(), userStartThreshold });
  },
  setUserEndThreshold: userEndThreshold => {
    set({ userEndThreshold });
    save({ ...get(), userEndThreshold });
  },
  setUserOpenHoldMs: userOpenHoldMs => {
    set({ userOpenHoldMs });
    save({ ...get(), userOpenHoldMs });
  },
  setUserTrailingHoldMs: userTrailingHoldMs => {
    set({ userTrailingHoldMs });
    save({ ...get(), userTrailingHoldMs });
  },
  resetSettings: () => {
    set(defaults);
    save(defaults);
  },
}));

/**
 * Resolved-thresholds snapshot. `null` overrides fall back to the
 * config.ts compile-time defaults. The Segmenter constructor consumes
 * this — pass at Session-start so user-tuned values are captured for
 * the lifetime of the Session.
 */
export type EffectiveThresholds = {
  startThreshold: number;
  endThreshold: number;
  openHoldMs: number;
  trailingHoldMs: number;
};

export function effectiveThresholds(
  s: Pick<
    PersistedSettings,
    | 'userStartThreshold'
    | 'userEndThreshold'
    | 'userOpenHoldMs'
    | 'userTrailingHoldMs'
  >,
): EffectiveThresholds {
  return {
    startThreshold: s.userStartThreshold ?? START_THRESHOLD,
    endThreshold: s.userEndThreshold ?? END_THRESHOLD,
    openHoldMs: s.userOpenHoldMs ?? OPEN_HOLD_MS,
    trailingHoldMs: s.userTrailingHoldMs ?? TRAILING_HOLD_MS,
  };
}

export const THRESHOLD_DEFAULTS = {
  startThreshold: START_THRESHOLD,
  endThreshold: END_THRESHOLD,
  openHoldMs: OPEN_HOLD_MS,
  trailingHoldMs: TRAILING_HOLD_MS,
} as const;

/**
 * UI-side mapping from the internal Mode identifier to the user-visible
 * label. Per decisions-log: code and persistence speak `'motion'` /
 * `'players'`; the UI calls them `Smart` / `Enhanced`. This helper is the
 * only place that knows about both name registers.
 */
export function labelForMode(
  mode: DetectionMode,
): 'Smart' | 'Enhanced' | 'Continuous' {
  if (mode === 'players') return 'Enhanced';
  if (mode === 'continuous') return 'Continuous';
  return 'Smart';
}

/**
 * Helper text pinned in decisions-log — keep these strings here so the
 * Settings screen and any future Setup-screen Mode chip share one source
 * of truth.
 */
export function helperTextForMode(mode: DetectionMode): string {
  if (mode === 'players') {
    return 'Also requires players to be on the court — fewer false starts during warm-ups and timeouts.';
  }
  if (mode === 'continuous') {
    return 'No detection. The Master Recording is saved directly as your video — no court ROI, no dead-time stripping. Use this for non-court captures or to validate the recorder.';
  }
  return 'Triggers on sustained motion inside the court.';
}
