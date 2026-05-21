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
};

const defaults: PersistedSettings = {
  alwaysSkipWarmup: false,
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
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...load(),
  setAlwaysSkipWarmup: alwaysSkipWarmup => {
    set({ alwaysSkipWarmup });
    save({ ...get(), alwaysSkipWarmup });
  },
  resetSettings: () => {
    set(defaults);
    save(defaults);
  },
}));
