/**
 * Setup screen — Court ROI definition before "Auto Record".
 *
 * Design: M0 verdict was Variant B (Guided wizard), see decisions-log.md.
 * Two steps:
 *   1. Instruction panel + drag to outline the court (normalized 0..1).
 *   2. Live-preview confirm with everything outside the ROI dimmed, so the
 *      user sees exactly what the detector will see before committing.
 *
 * The ROI is committed to `sessionMachine` on drag-end; the screen reads it
 * back to render the rectangle so a re-mount (or returning from Step 2)
 * preserves the framing. ROI is *not* persisted across Sessions per
 * decisions-log — `reset()` on Done clears it.
 */

import React, { useRef, useState } from 'react';
import {
  Alert,
  View,
  Text,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { CameraBackdrop } from '../components/CameraBackdrop';
import { CourtRoiOverlay } from '../components/CourtRoiOverlay';
import {
  useSessionStore,
  type Roi,
} from '../state/sessionMachine';
import { useSettingsStore } from '../state/settingsStore';
import { colors, radii, spacing, typography } from '../design/tokens';
import { openSession } from '../persistence/sessionRepo';
import { markFixedThreshold } from '../persistence/sessionRepo';
import {
  getFreeDiskBytes,
  requestNotificationPermission,
} from '../native/Splicer';

// Refuse to start a Session when free disk is below this. Conservative
// budget: 1080p hardware H.264 at the resolutions VisionCamera defaults
// to lands around ~3–6 GB per 90 minutes (ADR-0007). 2 GB at least
// guarantees ~30 minutes of headroom, so the user is never surprised
// mid-match by a "no space" error. The Library's "Delete Master" lets
// them free space without losing prior recordings.
const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

// Reject accidental taps / fingernail-sized rectangles. 5% of each axis is
// large enough to be intentional, small enough that "draw around the
// whole frame" still works.
const MIN_ROI_FRACTION = 0.05;

type Drag = { x1: number; y1: number; x2: number; y2: number } | null;

export function SetupScreen() {
  const step = useSessionStore(s => s.setupStep);
  return step === 1 ? <Step1 /> : <Step2 />;
}

function Step1() {
  const { width: W, height: H } = useWindowDimensions();
  const roi = useSessionStore(s => s.roi);
  const setRoi = useSessionStore(s => s.setRoi);
  const setSetupStep = useSessionStore(s => s.setSetupStep);
  const setAppScreen = useSessionStore(s => s.setAppScreen);
  const reset = useSessionStore(s => s.reset);

  const [drag, setDragState] = useState<Drag>(null);
  const dragRef = useRef<Drag>(null);
  const setDrag = (next: Drag) => {
    dragRef.current = next;
    setDragState(next);
  };

  const onBegin = (x: number, y: number) =>
    setDrag({ x1: x, y1: y, x2: x, y2: y });
  const onUpdate = (x: number, y: number) => {
    const d = dragRef.current;
    if (d) setDrag({ ...d, x2: x, y2: y });
  };
  const onEnd = () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    const x = Math.min(d.x1, d.x2);
    const y = Math.min(d.y1, d.y2);
    const w = Math.abs(d.x2 - d.x1);
    const h = Math.abs(d.y2 - d.y1);
    if (w / W < MIN_ROI_FRACTION || h / H < MIN_ROI_FRACTION) return;
    setRoi({ x: x / W, y: y / H, w: w / W, h: h / H });
  };

  const pan = Gesture.Pan()
    .minDistance(2)
    .onBegin(e => {
      'worklet';
      runOnJS(onBegin)(e.x, e.y);
    })
    .onUpdate(e => {
      'worklet';
      runOnJS(onUpdate)(e.x, e.y);
    })
    .onEnd(() => {
      'worklet';
      runOnJS(onEnd)();
    });

  const liveRoi: Roi | null = drag
    ? {
        x: Math.min(drag.x1, drag.x2) / W,
        y: Math.min(drag.y1, drag.y2) / H,
        w: Math.abs(drag.x2 - drag.x1) / W,
        h: Math.abs(drag.y2 - drag.y1) / H,
      }
    : roi;

  return (
    <View style={styles.root}>
      <CameraBackdrop />
      <View style={styles.instructionsPanel}>
        <Text style={styles.stepEyebrow}>Step 1 of 2</Text>
        <Text style={styles.stepTitle}>Frame the court</Text>
        <Text style={styles.stepBody}>Drag to outline the playing area.</Text>
      </View>
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill}>
          {liveRoi && <CourtRoiOverlay roi={liveRoi} />}
        </View>
      </GestureDetector>
      <Pressable
        style={styles.homeBtn}
        onPress={() => {
          // Going home from Step 1 should also drop any half-drawn ROI
          // so the next Start Recording lands clean.
          reset();
          setAppScreen('dashboard');
        }}
        accessibilityRole="button"
        accessibilityLabel="Back to Dashboard">
        <Text style={styles.homeBtnIcon}>‹</Text>
        <Text style={styles.homeBtnLabel}>Home</Text>
      </Pressable>
      <View style={styles.footerBar} pointerEvents="box-none">
        <Pressable
          onPress={roi ? () => setSetupStep(2) : undefined}
          style={[styles.primaryBtn, !roi && styles.primaryBtnDisabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !roi }}
          accessibilityLabel="Next: confirm framing">
          <Text
            style={[
              styles.primaryBtnText,
              !roi && styles.primaryBtnTextDisabled,
            ]}>
            Next  ›
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function Step2() {
  const roi = useSessionStore(s => s.roi);
  const setSetupStep = useSessionStore(s => s.setSetupStep);
  const beginCalibration = useSessionStore(s => s.beginCalibration);
  const skipCalibration = useSessionStore(s => s.skipCalibration);
  const alwaysSkipWarmup = useSettingsStore(s => s.alwaysSkipWarmup);

  // Step 2 is unreachable without a valid ROI (Next is disabled in Step 1),
  // but the type system doesn't know that — short-circuit defensively.
  if (!roi) {
    return null;
  }

  const onConfirm = async () => {
    // Pre-flight disk check (M7). Surface a friendly Alert and bail
    // before opening the Session row — better to refuse here than
    // crash the splice 90 minutes from now with "No space on device".
    try {
      const free = await getFreeDiskBytes();
      if (free < MIN_FREE_DISK_BYTES) {
        const gb = (free / (1024 ** 3)).toFixed(1);
        Alert.alert(
          'Not enough storage',
          `Your iPhone only has ${gb} GB free. Recording a match safely needs at least 2 GB. Free up some space (or delete old Masters from My Sessions) and try again.`,
        );
        return;
      }
    } catch (e: any) {
      console.warn('[SetupScreen] disk check failed', e?.message ?? e);
      // Fall through — better to attempt the Session than block it on
      // a diagnostic failure. The splice will surface the real error
      // if one shows up later.
    }

    // Best-effort notification permission so M6's background-stop path
    // can fire the "Session ended early" alert. Non-blocking — we
    // continue regardless of the user's choice.
    requestNotificationPermission().catch(e =>
      console.warn('[SetupScreen] notification permission failed', e?.message ?? e),
    );

    // Persist the Session row up-front so crash-recovery (M5) has
    // somewhere to land if the app dies before the recorder finalizes.
    const startedAt = Date.now();
    const sessionId = openSession({ startedAtMs: startedAt, roi });
    beginCalibration(startedAt, sessionId);
    if (alwaysSkipWarmup) {
      // Honour the Settings opt-out — the user has told us they
      // routinely arrive mid-match, so the baseline can't learn a
      // clean idle court. Flip straight into Watching with the
      // fixed-threshold detector and mirror the choice to DB.
      skipCalibration();
      try {
        markFixedThreshold(sessionId);
      } catch (e: any) {
        console.warn('[SetupScreen] markFixedThreshold failed', e?.message ?? e);
      }
    }
  };

  return (
    <View style={styles.root}>
      <CameraBackdrop />
      <Dimmer roi={roi} />
      <CourtRoiOverlay roi={roi} />
      <View style={styles.instructionsPanel}>
        <Text style={styles.stepEyebrow}>Step 2 of 2</Text>
        <Text style={styles.stepTitle}>Confirm the framing</Text>
        <Text style={styles.stepBody}>
          The dimmed area is what will be ignored.
        </Text>
      </View>
      <View style={styles.footerBarSplit} pointerEvents="box-none">
        <Pressable
          onPress={() => setSetupStep(1)}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Edit framing">
          <Text style={styles.backBtnText}>‹  Edit</Text>
        </Pressable>
        <Pressable
          style={styles.primaryBtn}
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel="Auto record">
          <Text style={styles.primaryBtnText}>▶  Auto Record</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Dimmer({ roi }: { roi: Roi }) {
  const { width: W, height: H } = useWindowDimensions();
  const left = roi.x * W;
  const top = roi.y * H;
  const right = left + roi.w * W;
  const bottom = top + roi.h * H;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.dim, styles.dimTopRow, { height: top }]} />
      <View style={[styles.dim, styles.dimBottomRow, { top: bottom }]} />
      <View
        style={[
          styles.dim,
          styles.dimLeftCol,
          { top, width: left, height: bottom - top },
        ]}
      />
      <View
        style={[
          styles.dim,
          styles.dimRightCol,
          { top, left: right, height: bottom - top },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  instructionsPanel: {
    position: 'absolute',
    top: 110,
    left: spacing.base,
    right: spacing.base,
    backgroundColor: colors.surfacePanel,
    borderRadius: radii.lg,
    padding: spacing.md + 2,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepEyebrow: {
    ...typography.caption,
    color: colors.stateSoft.watching,
    fontWeight: '700',
  },
  stepTitle: { ...typography.heading, color: colors.text },
  stepBody: { ...typography.body, color: colors.textMuted, fontSize: 13 },
  dim: { position: 'absolute', backgroundColor: colors.dimMask },
  dimTopRow: { left: 0, right: 0, top: 0 },
  dimBottomRow: { left: 0, right: 0, bottom: 0 },
  dimLeftCol: { left: 0 },
  dimRightCol: { right: 0 },
  footerBar: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  footerBarSplit: {
    position: 'absolute',
    bottom: 60,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  primaryBtn: {
    backgroundColor: colors.actionStart,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.pill,
  },
  primaryBtnDisabled: { backgroundColor: colors.divider },
  primaryBtnText: {
    ...typography.display,
    color: colors.actionText,
    letterSpacing: 0.8,
  },
  primaryBtnTextDisabled: { color: colors.textSubtle },
  backBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSubtle,
  },
  backBtnText: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 14,
  },
  // Setup Step 1's top-left "Home" pill — replaces the M5/M7 hamburger.
  // The drawer lives on the Dashboard now; Setup keeps a single back
  // path out so the screen stays focused on framing the court.
  homeBtn: {
    position: 'absolute',
    top: 60,
    left: spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surfacePanel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  homeBtnIcon: {
    ...typography.display,
    color: colors.text,
    fontSize: 20,
    lineHeight: 22,
  },
  homeBtnLabel: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 13,
  },
});
