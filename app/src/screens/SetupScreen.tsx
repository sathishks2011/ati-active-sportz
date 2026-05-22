/**
 * Setup screen — Court ROI definition before "Auto Record".
 *
 * Design: M0 verdict was Variant B (Guided wizard), see decisions-log.md.
 * Two steps:
 *   1. Tap the four corners of the court in TL → TR → BR → BL order
 *      (ADR-0010). The screen guides the user through each tap with the
 *      instruction panel and shows a numbered marker at each placed
 *      corner; the four edges connect once enough corners exist.
 *   2. Live-preview confirm with everything outside the ROI (approximated
 *      by its axis-aligned bounding box; SVG masking is not available
 *      without `react-native-svg`) dimmed, so the user sees what the
 *      detector will see before committing.
 *
 * The ROI is committed to `sessionMachine` on the fourth tap (subject to
 * convexity validation); the screen reads it back to render the polygon
 * so a re-mount or a return from Step 2 preserves the framing. ROI is
 * *not* persisted across Sessions per decisions-log — `reset()` on Done
 * clears it.
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
import {
  CameraBackdrop,
  MAX_SETUP_ZOOM,
  MIN_SETUP_ZOOM,
} from '../components/CameraBackdrop';
import { CourtRoiOverlay } from '../components/CourtRoiOverlay';
import {
  useSessionStore,
  type Roi,
  type RoiCorner,
} from '../state/sessionMachine';
import {
  useSettingsStore,
  labelForMode,
  helperTextForMode,
} from '../state/settingsStore';
import type { DetectionMode } from '../persistence/sessionRepo';
import { isConvexQuad, quadBoundingBox, ROI_CORNER_LABELS } from '../state/roi';
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

// Visible corner marker radius in screen pixels.
const CORNER_DOT_RADIUS = 14;

export function SetupScreen() {
  const step = useSessionStore(s => s.setupStep);
  const mode = useSettingsStore(s => s.detectionMode);
  // Continuous Mode (ADR-0009 amendment, decisions-log) skips the
  // four-corner step entirely — there's no Court ROI in continuous
  // recording. The wrapper short-circuits to Step 2 without writing
  // back to setupStep so the user can still navigate back via
  // `setSetupStep(1)` if they switch Mode to motion / players.
  if (mode === 'continuous' && step === 1) {
    return <Step2 />;
  }
  return step === 1 ? <Step1 /> : <Step2 />;
}

function Step1() {
  const { width: W, height: H } = useWindowDimensions();
  const roi = useSessionStore(s => s.roi);
  const setRoi = useSessionStore(s => s.setRoi);
  const setupZoom = useSessionStore(s => s.setupZoom);
  const setSetupZoom = useSessionStore(s => s.setSetupZoom);
  const setSetupStep = useSessionStore(s => s.setSetupStep);
  const setAppScreen = useSessionStore(s => s.setAppScreen);
  const reset = useSessionStore(s => s.reset);

  // Locally placed corners (0..4). Stored in *screen pixels* during
  // Step 1 so the markers track the tap precisely; normalized only on
  // commit. If we already have a committed ROI (returning from Step 2),
  // seed the local state from it.
  const [pixels, setPixels] = useState<{ x: number; y: number }[]>(() =>
    roi
      ? roi.corners.map(c => ({ x: c[0] * W, y: c[1] * H }))
      : [],
  );

  // Pinch-to-zoom (decisions-log: "Pinch-to-zoom at Setup"). We track
  // the zoom factor at the *start* of the pinch in a ref so each
  // gesture-update tick multiplies against a stable base; the running
  // value is committed to the session store on each tick so the
  // CameraBackdrop re-renders with the new `zoom` prop. The Camera
  // accepts a direct number prop on iOS; smoothness is adequate at
  // this rate because the Camera handles interpolation internally.
  const pinchStartZoomRef = useRef(setupZoom);

  const updateZoomJS = (next: number) => {
    const clamped = Math.max(MIN_SETUP_ZOOM, Math.min(MAX_SETUP_ZOOM, next));
    setSetupZoom(clamped);
  };
  const setPinchStart = () => {
    pinchStartZoomRef.current = setupZoom;
  };

  const placedCount = pixels.length;
  const nextLabel = placedCount < 4 ? ROI_CORNER_LABELS[placedCount] : null;

  const onTap = (x: number, y: number) => {
    if (placedCount >= 4) return;
    const next = [...pixels, { x, y }];
    setPixels(next);
    if (next.length === 4) {
      const normalized = next.map(p => [p.x / W, p.y / H] as RoiCorner);
      if (!isConvexQuad(normalized)) {
        Alert.alert(
          "That doesn't look like a court",
          "The four corners need to outline a convex shape (no crossed edges). Tap Reset and try again — top-left, top-right, bottom-right, bottom-left.",
          [{ text: 'Reset', onPress: () => setPixels([]) }],
        );
        return;
      }
      setRoi({
        corners: [
          normalized[0],
          normalized[1],
          normalized[2],
          normalized[3],
        ] as const,
      });
    } else if (roi != null) {
      // Partial re-edit clears any previously committed ROI so Next
      // can't sneak the user through with stale corners.
      setRoi(null);
    }
  };

  const onReset = () => {
    setPixels([]);
    setRoi(null);
  };

  // Pinch (two-finger) sits in a GestureDetector that's a *sibling* of
  // the tap-to-place Pressable, not its parent. Two reasons:
  //   1. gesture-handler's UIGestureRecognizer attaches to the
  //      GestureDetector's child view with `cancelsTouchesInView=true`
  //      by default — when the child is `absoluteFill` the recognizer
  //      sees touches over the whole screen and can swallow taps that
  //      should reach later-rendered Pressables (Reset, Next, Home).
  //   2. Constraining the pinch hit area to the central preview band
  //      means the footer buttons live entirely outside the gesture
  //      view's bounds and the native recognizer never gets a chance
  //      to interfere with their touches.
  // Pinch requires two fingers, so a tap on the central band still
  // falls through to the Pressable underneath (rendered earlier so
  // higher in the visual stack? No — rendered earlier means *behind*.
  // The pinch View is on top in document order, with `pointerEvents`
  // `'box-only'` so it doesn't pass touches to *its own* children, but
  // still receives them itself for the gesture-handler bridge).
  const pinchGesture = Gesture.Pinch()
    .onBegin(() => {
      'worklet';
      runOnJS(setPinchStart)();
    })
    .onUpdate(e => {
      'worklet';
      runOnJS(updateZoomJS)(pinchStartZoomRef.current * e.scale);
    });

  const liveRoi: Roi | null = roi;
  const zoomPct = (setupZoom).toFixed(1);

  return (
    <View style={styles.root}>
      <CameraBackdrop zoom={setupZoom} />
      {/* Tap-to-place layer (RN Pressable; standard responder system). */}
      <Pressable
        style={styles.tapLayer}
        onPress={e => onTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
        accessibilityRole="button"
        accessibilityLabel={
          nextLabel
            ? `Tap to place ${nextLabel} corner`
            : 'All four corners placed'
        }>
        {liveRoi && <CourtRoiOverlay roi={liveRoi} />}
        {pixels.map((p, i) => (
          <CornerDot key={i} x={p.x} y={p.y} index={i + 1} />
        ))}
      </Pressable>
      {/* Pinch-only gesture layer — sibling, bounded, no footer overlap. */}
      <GestureDetector gesture={pinchGesture}>
        <View pointerEvents="box-only" style={styles.pinchLayer} />
      </GestureDetector>
      <View style={styles.instructionsPanel}>
        <Text style={styles.stepEyebrow}>Step 1 of 2</Text>
        <Text style={styles.stepTitle}>Tap the four corners</Text>
        <Text style={styles.stepBody}>
          {nextLabel
            ? `Tap the ${nextLabel} corner of the court.`
            : 'All four corners placed. Tap Next to confirm.'}
        </Text>
        <Text style={styles.stepHint}>
          Pinch to zoom (two fingers). Tap Reset to start over.
        </Text>
      </View>
      <View pointerEvents="none" style={styles.zoomBadge}>
        <Text style={styles.zoomBadgeText}>{zoomPct}×</Text>
      </View>
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
      <View style={styles.footerBarSplit} pointerEvents="box-none">
        <Pressable
          onPress={placedCount > 0 ? onReset : undefined}
          style={[
            styles.resetBtn,
            placedCount === 0 && styles.resetBtnDisabled,
          ]}
          accessibilityRole="button"
          accessibilityState={{ disabled: placedCount === 0 }}
          accessibilityLabel="Reset corners">
          <Text style={styles.resetBtnText}>↺  Reset</Text>
        </Pressable>
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

/**
 * One pill in the Setup-screen Mode segmented control. Internal value
 * (`'motion'` / `'players'`) goes to the setter; the visible label
 * comes from `labelForMode` per decisions-log: "Detection Mode names".
 */
function ModeSegment({
  value,
  selected,
  onSelect,
}: {
  value: DetectionMode;
  selected: boolean;
  onSelect: (mode: DetectionMode) => void;
}) {
  return (
    <Pressable
      onPress={() => onSelect(value)}
      style={[
        styles.modeSegment,
        selected && styles.modeSegmentSelected,
      ]}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${labelForMode(value)} mode`}>
      <Text
        style={[
          styles.modeSegmentText,
          selected && styles.modeSegmentTextSelected,
        ]}>
        {labelForMode(value)}
      </Text>
    </Pressable>
  );
}

function CornerDot({
  x,
  y,
  index,
}: {
  x: number;
  y: number;
  index: number;
}) {
  return (
    <View
      pointerEvents="none"
      style={[
        styles.cornerDot,
        {
          left: x - CORNER_DOT_RADIUS,
          top: y - CORNER_DOT_RADIUS,
        },
      ]}>
      <Text style={styles.cornerDotLabel}>{index}</Text>
    </View>
  );
}

function Step2() {
  const roi = useSessionStore(s => s.roi);
  const setupZoom = useSessionStore(s => s.setupZoom);
  const setSetupStep = useSessionStore(s => s.setSetupStep);
  const beginCalibration = useSessionStore(s => s.beginCalibration);
  const skipCalibration = useSessionStore(s => s.skipCalibration);
  const alwaysSkipWarmup = useSettingsStore(s => s.alwaysSkipWarmup);
  const detectionMode = useSettingsStore(s => s.detectionMode);
  const setDetectionMode = useSettingsStore(s => s.setDetectionMode);

  const isContinuous = detectionMode === 'continuous';

  // Switching from Continuous to a detection mode while in Step 2 needs
  // to drop the user back to Step 1 so they can draw the polygon. The
  // segmented control routes through this so the redirect happens at
  // the source of the change.
  const onSwitchMode = (next: DetectionMode) => {
    setDetectionMode(next);
    if (next !== 'continuous' && roi == null) {
      setSetupStep(1);
    }
  };

  // Non-continuous modes need a committed ROI. Step 1's Next button
  // gates on this, but defensively short-circuit here too. Continuous
  // mode skips the polygon entirely so a null `roi` is expected.
  if (!isContinuous && !roi) {
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
    // `setupZoom` is the value the user landed on via pinch-to-zoom in
    // Step 1 (decisions-log: "Pinch-to-zoom at Setup") — frozen here
    // and re-applied as the Camera `zoom` prop on the RecordingScreen
    // so the worklet sees exactly the framing the user chose.
    const startedAt = Date.now();
    const sessionId = openSession({
      startedAtMs: startedAt,
      roi,
      setupZoom,
      detectionMode,
    });
    beginCalibration(startedAt, sessionId);
    // Continuous mode has no detector → no baseline to learn → skip
    // Calibrating entirely. The user goes straight to the recording
    // view without the 15s warm-up screen.
    if (isContinuous || alwaysSkipWarmup) {
      // Honour the Settings opt-out (or the lack of a detector in
      // Continuous mode) — flip straight into Watching with the
      // fixed-threshold detector and mirror the choice to DB. For
      // Continuous mode the fixed-threshold flag is cosmetic since
      // no detection runs anyway.
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
      <CameraBackdrop zoom={setupZoom} />
      {/* Dim + polygon overlay only when a polygon exists (i.e., not
          Continuous mode). Continuous mode shows the live preview clean. */}
      {!isContinuous && roi && <Dimmer roi={roi} />}
      {!isContinuous && roi && <CourtRoiOverlay roi={roi} />}
      <View style={styles.instructionsPanel}>
        <Text style={styles.stepEyebrow}>
          {isContinuous ? 'Ready to record' : 'Step 2 of 2'}
        </Text>
        <Text style={styles.stepTitle}>
          {isContinuous ? 'Continuous recording' : 'Confirm the framing'}
        </Text>
        <Text style={styles.stepBody}>
          {isContinuous
            ? 'No detection. The whole recording is saved to Photos as-is.'
            : 'The dimmed area is what will be ignored.'}
        </Text>
        <View style={styles.modePickerRow}>
          <Text style={styles.modeChipLabel}>Mode</Text>
          <View style={styles.modeSegmentedControl}>
            <ModeSegment
              value="motion"
              selected={detectionMode === 'motion'}
              onSelect={onSwitchMode}
            />
            <ModeSegment
              value="players"
              selected={detectionMode === 'players'}
              onSelect={onSwitchMode}
            />
            <ModeSegment
              value="continuous"
              selected={detectionMode === 'continuous'}
              onSelect={onSwitchMode}
            />
          </View>
        </View>
        <Text style={styles.modeHelper}>
          {helperTextForMode(detectionMode)}
        </Text>
        <View style={styles.modeChipRow}>
          <Text style={styles.modeChipLabel}>Zoom</Text>
          <View style={styles.modeChip}>
            <Text style={styles.modeChipValue}>{setupZoom.toFixed(1)}×</Text>
          </View>
        </View>
      </View>
      <View style={styles.footerBarSplit} pointerEvents="box-none">
        {!isContinuous ? (
          <Pressable
            onPress={() => setSetupStep(1)}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Edit framing">
            <Text style={styles.backBtnText}>‹  Edit</Text>
          </Pressable>
        ) : (
          // Continuous mode has nothing to edit (no polygon). Render
          // an empty spacer so the Auto Record button stays anchored
          // to the right edge of the split footer.
          <View />
        )}
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

/**
 * Step-2 dim affordance. We dim the four rectangular strips outside the
 * polygon's axis-aligned bounding box rather than the precise outside-of-
 * polygon region — proper polygon masking would need `react-native-svg`
 * or a Skia surface, neither of which is currently a dependency. The
 * approximation still gives the user a clear "this is what we're
 * looking at" affordance; the polygon stroke from CourtRoiOverlay sits
 * on top and tells the precise story.
 */
function Dimmer({ roi }: { roi: Roi }) {
  const { width: W, height: H } = useWindowDimensions();
  const bbox = quadBoundingBox(roi);
  const left = bbox.x * W;
  const top = bbox.y * H;
  const right = left + bbox.w * W;
  const bottom = top + bbox.h * H;
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
  stepHint: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    marginTop: 4,
  },
  zoomBadge: {
    position: 'absolute',
    top: 60,
    right: spacing.base,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surfacePanel,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 56,
    alignItems: 'center',
  },
  zoomBadgeText: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 13,
  },
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
  backBtnDisabled: { opacity: 0.4 },
  backBtnText: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 14,
  },
  // Visually prominent Reset for Step 1 — warm-tone outlined pill so
  // it stands out from the surfaceSubtle "back/edit" pattern used
  // elsewhere. Reset is the only way out of a stuck-corner state, so
  // it earns its own visual weight.
  resetBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.actionStop,
  },
  resetBtnDisabled: { opacity: 0.35 },
  resetBtnText: {
    ...typography.bodyEmphasis,
    color: colors.actionStop,
    fontSize: 14,
  },
  // Tap-to-place hit area — fills the screen behind the gesture
  // layer. Standard RN responder system handles single-finger taps.
  // Later siblings (footer, home, gesture layer) are rendered on top.
  tapLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Pinch-to-zoom hit area — bounded so the footer (and the home
  // button at the top) sit outside the gesture-handler view. Without
  // this bound, the native UIGestureRecognizer eats taps that should
  // reach the Reset / Next Pressables.
  pinchLayer: {
    position: 'absolute',
    top: 200,
    left: 0,
    right: 0,
    bottom: 140,
  },
  cornerDot: {
    position: 'absolute',
    width: CORNER_DOT_RADIUS * 2,
    height: CORNER_DOT_RADIUS * 2,
    borderRadius: CORNER_DOT_RADIUS,
    backgroundColor: colors.roiStroke,
    borderWidth: 2,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerDotLabel: {
    ...typography.bodyEmphasis,
    color: colors.bg,
    fontSize: 12,
    lineHeight: 14,
  },
  modeChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  modeChipLabel: {
    ...typography.caption,
    color: colors.textSubtle,
    fontWeight: '700',
  },
  modeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSubtle,
  },
  modeChipValue: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 12,
  },
  modePickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  modeSegmentedControl: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.pill,
    padding: 2,
    gap: 2,
  },
  modeSegment: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm - 2,
    borderRadius: radii.pill,
  },
  modeSegmentSelected: {
    backgroundColor: colors.actionStart,
  },
  modeSegmentText: {
    ...typography.bodyEmphasis,
    color: colors.textMuted,
    fontSize: 12,
  },
  modeSegmentTextSelected: {
    color: colors.actionText,
  },
  modeHelper: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 11,
    lineHeight: 14,
    marginTop: 4,
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
