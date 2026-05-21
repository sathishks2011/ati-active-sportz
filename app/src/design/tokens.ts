/**
 * Active Sportz — design tokens v0.
 *
 * The single source of truth for color, spacing, radii, typography, and motion.
 * Dark-themed by default: the entire app is camera-first, so the chrome reads
 * onto live footage that is itself usually dim.
 *
 * This file is the one M0-era artifact that survives M2's prototype cleanup.
 * The production Setup / Recording / Library / Done screens built in M2
 * compose from these tokens — do not introduce ad-hoc hex values in screen
 * files; add to the palette here and reference by name.
 */

import type { TextStyle } from 'react-native';

import type { SessionState } from '../state/sessionMachine';

// ─── Colors ──────────────────────────────────────────────────────────────────

export const colors = {
  // Surfaces — dark theme
  bg: '#000000',
  surface: '#1a1a1a',
  surfacePanel: 'rgba(0, 0, 0, 0.65)', // semi-transparent panel over camera
  surfaceSubtle: 'rgba(255, 255, 255, 0.12)', // ghost button background
  border: '#333333',
  divider: '#444444',

  // Text
  text: '#ffffff',
  textMuted: '#cccccc',
  textSubtle: '#888888',
  textDisabled: '#555555',

  // Camera overlay
  roiStroke: '#ffffff',
  roiCapturingFill: 'rgba(232, 90, 59, 0.18)', // matches state.capturing
  dimMask: 'rgba(0, 0, 0, 0.6)', // outside-ROI dim in Setup B's Step 2

  // Action — Start (green "go")
  actionStart: '#3b8b58',
  // Action — Stop (warm "halt")
  actionStop: '#e85a3b',
  actionText: '#ffffff',

  // Session State accents — each state has one signature color.
  // Capturing intentionally shares the Stop button's warm tone so the eye
  // associates "warm = active = recording right now". Done shares Start's
  // green to close the loop (you're back to a non-running state).
  state: {
    setup: '#6b7280', // pre-recording, neutral gray
    calibrating: '#a07a2f', // warm-up — amber, informational
    watching: '#3c6e9e', // dead time — calm blue, monitoring
    capturing: '#e85a3b', // active play — warm orange, "ON"
    stopping: '#6b6b6b', // transition — gray
    done: '#3b8b58', // finished — green, success
  },

  // Soft variants of state colors for use as foreground text over dark camera
  stateSoft: {
    setup: '#a3acb8',
    calibrating: '#e8c577',
    watching: '#a9c9ee',
    capturing: '#ff7a5a',
    stopping: '#bbbbbb',
    done: '#7adba0',
  },

  shadow: '#000000',
};

// ─── Spacing — 4-pt grid ─────────────────────────────────────────────────────

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

// ─── Radii ───────────────────────────────────────────────────────────────────

export const radii = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
};

// ─── Typography ──────────────────────────────────────────────────────────────

export const typography = {
  // Big state badges, primary CTA labels
  display: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1.2,
  } satisfies TextStyle,

  // Compact state pills, secondary CTA labels
  badge: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
  } satisfies TextStyle,

  // Step titles, screen-level headings
  heading: {
    fontSize: 18,
    fontWeight: '700',
  } satisfies TextStyle,

  // Instructions, body copy
  body: {
    fontSize: 14,
    fontWeight: '400',
  } satisfies TextStyle,
  bodyEmphasis: {
    fontSize: 14,
    fontWeight: '700',
  } satisfies TextStyle,

  // Eyebrows ("Step 1 of 2"), small labels ("State", "Motion")
  caption: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
  } satisfies TextStyle,

  // Timestamps, motion scores — anything numeric
  mono: {
    fontSize: 13,
    fontFamily: 'Menlo',
  } satisfies TextStyle,
  monoSmall: {
    fontSize: 11,
    fontFamily: 'Menlo',
  } satisfies TextStyle,
};

// Text-shadow preset for chrome that overlays the live camera feed —
// keeps labels legible against any backdrop without a solid container.
export const overlayShadow: TextStyle = {
  textShadowColor: 'rgba(0, 0, 0, 0.7)',
  textShadowRadius: 4,
  textShadowOffset: { width: 0, height: 1 },
};

// ─── Motion ──────────────────────────────────────────────────────────────────

export const motion = {
  fast: 150,
  normal: 250,
  slow: 400,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function colorForState(state: SessionState): string {
  switch (state) {
    case 'Setup':
      return colors.state.setup;
    case 'Calibrating':
      return colors.state.calibrating;
    case 'Watching':
      return colors.state.watching;
    case 'Capturing':
      return colors.state.capturing;
    case 'Stopping':
      return colors.state.stopping;
    case 'Done':
      return colors.state.done;
  }
}

export function softColorForState(state: SessionState): string {
  switch (state) {
    case 'Setup':
      return colors.stateSoft.setup;
    case 'Calibrating':
      return colors.stateSoft.calibrating;
    case 'Watching':
      return colors.stateSoft.watching;
    case 'Capturing':
      return colors.stateSoft.capturing;
    case 'Stopping':
      return colors.stateSoft.stopping;
    case 'Done':
      return colors.stateSoft.done;
  }
}
