/**
 * Recording screen — live Session.
 *
 * Design: M0 verdict was Variant B (Smart-film chip), see decisions-log.md.
 *   - Top compact state pill on the left.
 *   - Top-right vertical motion bars (cool → warm → hot color graduation).
 *   - Court ROI rectangle; translucent warm fill only while `Capturing`.
 *   - Bottom-right FAB Stop, action color carries the state.
 *
 * Lifecycle: this screen is the one place where `Camera +
 * useVideoOutput + useFrameOutput` are bound. It mounts when
 * `sessionMachine` is in any running state (Calibrating | Watching |
 * Capturing | Stopping). On mount it starts the Master Recording and the
 * motion Frame Processor. On Stop it transitions to Stopping, stops the
 * recorder, splices the Master using the segments the Segmenter emitted
 * during the run, saves to Photos, and transitions to Done.
 *
 * M3 detection wiring:
 *   - The Frame Processor runs Y-plane diffing inside the ROI and emits
 *     a motion score (0..1) every Nth frame via `runOnJS`.
 *   - That score feeds both the motion-bar UI (`setMotionScore`) and the
 *     Segmenter (`src/detection/segmenter.ts`), which holds the
 *     open/close hysteresis and produces ActiveSegmentRecords.
 *   - The Segmenter is gated off during `Calibrating` so no Active
 *     Segments are emitted from the Warm-up window (CONTEXT.md).
 *   - On Stop we `forceClose` any in-flight Segment before splicing.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  ActivityIndicator,
  AppState,
  type AppStateStatus,
} from 'react-native';
import {
  Camera,
  CommonResolutions,
  useCameraDevices,
  useVideoOutput,
  type CameraVideoOutput,
} from 'react-native-vision-camera';
import {
  CameraRoll,
  iosRequestAddOnlyGalleryPermission,
} from '@react-native-camera-roll/camera-roll';
import {
  setIdleTimerDisabled,
  splice,
  type ActiveSegment,
} from '../native/Splicer';
import { CourtRoiOverlay } from '../components/CourtRoiOverlay';
import {
  CALIBRATION_DURATION_MS,
  useSessionStore,
  type ActiveSegmentRecord,
  type DoneInfo,
  type SessionState,
} from '../state/sessionMachine';
import {
  colors,
  colorForState,
  motion as motionTokens,
  overlayShadow,
  radii,
  spacing,
  typography,
} from '../design/tokens';
import {
  useMotionFrameOutput,
  type MotionPhase,
} from '../detection/motionFrameProcessor';
import { Segmenter } from '../detection/segmenter';
import {
  attachMasterUri,
  markDone,
  markFixedThreshold,
  markStopping,
} from '../persistence/sessionRepo';
import { appendSegment } from '../persistence/segmentRepo';

const BAR_COUNT = 5;
const BAR_MAX = 22;
const BAR_MIN = 4;

export function RecordingScreen() {
  const devices = useCameraDevices();
  const device = useMemo(
    () =>
      devices.find(d => d.position === 'back' && d.type === 'wide-angle') ??
      devices.find(d => d.position === 'back'),
    [devices],
  );

  // CommonResolutions.FHD_16_9 is a module-level constant — using an inline
  // literal here would replace the memoized output every render and break
  // the in-flight recorder. Audio off per ADR-0001.
  const videoOutput = useVideoOutput({
    targetResolution: CommonResolutions.FHD_16_9,
    enableAudio: false,
  });

  const sessionState = useSessionStore(s => s.sessionState);
  const recordingStartedAt = useSessionStore(s => s.recordingStartedAt);
  const roi = useSessionStore(s => s.roi);
  const motionScore = useSessionStore(s => s.motionScore);
  const setMotionScore = useSessionStore(s => s.setMotionScore);
  const useFixedThreshold = useSessionStore(s => s.useFixedThreshold);
  const endCalibration = useSessionStore(s => s.endCalibration);
  const skipCalibration = useSessionStore(s => s.skipCalibration);
  const markRecorderStarted = useSessionStore(s => s.markRecorderStarted);
  const openActiveSegment = useSessionStore(s => s.openActiveSegment);
  const closeActiveSegment = useSessionStore(s => s.closeActiveSegment);
  const beginStopping = useSessionStore(s => s.beginStopping);
  const finishWithSuccess = useSessionStore(s => s.finishWithSuccess);
  const finishWithError = useSessionStore(s => s.finishWithError);

  const recorderRef = useRef<Awaited<
    ReturnType<CameraVideoOutput['createRecorder']>
  > | null>(null);
  // Guards against starting more than one recorder per mount and against
  // double-tapping Stop while the splice is in flight.
  const recorderStartedRef = useRef(false);
  const stopRequestedRef = useRef(false);
  // `videoOutput` is constructed synchronously by useVideoOutput, but
  // VisionCamera does not bind it to the AVCaptureSession until the Camera
  // view has actually rendered and the session is running — calling
  // `createRecorder().startRecording()` before that throws "VideoOutput is
  // not yet connected to the CameraSession!". We gate on `onPreviewStarted`,
  // which fires when the first preview frame arrives — by then the output
  // is wired up.
  const [previewStarted, setPreviewStarted] = useState(false);
  // Wall-clock at the moment the recorder.startRecording promise resolved
  // — i.e., the camera is actually writing frames to the Master. Used as
  // the time origin for ActiveSegmentRecord seconds-into-Master. Held in
  // a ref because it's read inside the Frame Processor's runOnJS callback
  // and we don't want re-renders to swap the closure.
  const recorderStartedAtRef = useRef<number | null>(null);

  // The Segmenter outlives individual renders (it holds open-Segment
  // state). Construct it once with stable callbacks that read the latest
  // store actions / ref via closure.
  const segmenterRef = useRef<Segmenter | null>(null);
  if (segmenterRef.current == null) {
    segmenterRef.current = new Segmenter({
      onOpen: () => openActiveSegment(),
      onClose: (segment: ActiveSegmentRecord) => {
        closeActiveSegment(segment);
        // Append to DB synchronously so the row is durable before any
        // subsequent crash. The Segmenter only emits `onClose` for
        // already-finalized Segments, so there is no half-state to
        // recover from later.
        const sid = useSessionStore.getState().currentSessionId;
        if (sid != null) {
          try {
            appendSegment({ sessionId: sid, segment });
          } catch (e: any) {
            console.warn('[RecordingScreen] appendSegment failed', e?.message ?? e);
          }
        }
      },
      toMasterSeconds: (atMs: number) => {
        const origin = recorderStartedAtRef.current;
        if (origin == null) return 0;
        return Math.max(0, (atMs - origin) / 1000);
      },
    });
  }

  // The Frame Processor's per-frame onScore runs on JS (via runOnJS).
  // We update the motion-bar UI and feed the Segmenter — both cheap.
  const onScore = (score: number, atMs: number) => {
    setMotionScore(score);
    segmenterRef.current?.onScore(score, atMs);
  };

  // Detection phase (ADR-0006 / M4):
  //   - Skip Calibration tapped → `fixed` for the entire Session (M3
  //     fallback, no usable baseline learned).
  //   - Otherwise: `warmup` during Calibrating (baseline accumulates,
  //     no Segments emit), `detect` once Watching begins (score is
  //     deviation-from-baseline).
  const phase: MotionPhase = useFixedThreshold
    ? 'fixed'
    : sessionState === 'Calibrating'
      ? 'warmup'
      : 'detect';

  const frameOutput = useMotionFrameOutput({ roi, phase, onScore });

  // Calibrating → Watching after the warm-up window (ADR-0006). M4 will
  // swap this fixed timeout for the adaptive-baseline-ready signal.
  useEffect(() => {
    if (sessionState !== 'Calibrating') return;
    const t = setTimeout(endCalibration, CALIBRATION_DURATION_MS);
    return () => clearTimeout(t);
  }, [sessionState, endCalibration]);

  // Gate the Segmenter on the *post-Calibrating* phase. During Warm-up
  // we still process frames (the motion-bar UI animates so the user can
  // see the detector is alive) but the open/close machine ignores them
  // — Active Segments are not emitted from the Warm-up window per
  // CONTEXT.md.
  useEffect(() => {
    const enabled =
      sessionState === 'Watching' || sessionState === 'Capturing';
    segmenterRef.current?.setEnabled(enabled);
  }, [sessionState]);

  useEffect(() => {
    if (!device) return;
    if (!previewStarted) return;
    if (recorderStartedRef.current) return;
    if (
      sessionState !== 'Calibrating' &&
      sessionState !== 'Watching' &&
      sessionState !== 'Capturing'
    ) {
      return;
    }
    recorderStartedRef.current = true;
    startRecording(
      videoOutput,
      recorderRef,
      masterUri => {
        // Persist the path *before* the recorder is asked to start —
        // the file may not exist on disk yet, but the DB now knows
        // where to look during crash recovery.
        const sid = useSessionStore.getState().currentSessionId;
        if (sid != null) {
          try {
            attachMasterUri(sid, masterUri);
          } catch (e: any) {
            console.warn('[RecordingScreen] attachMasterUri failed', e?.message ?? e);
          }
        }
      },
      () => {
        const at = Date.now();
        recorderStartedAtRef.current = at;
        markRecorderStarted(at);
      },
      masterUri => {
        const final = useSessionStore.getState();
        onMasterFinished(
          masterUri,
          final.currentSessionId,
          recordingStartedAt,
          final.segments,
          final.useFixedThreshold,
          finishWithSuccess,
          finishWithError,
        );
      },
      finishWithError,
    );
  }, [
    device,
    previewStarted,
    videoOutput,
    sessionState,
    recordingStartedAt,
    markRecorderStarted,
    finishWithSuccess,
    finishWithError,
  ]);

  const onStop = async () => {
    if (stopRequestedRef.current) return;
    if (!recorderRef.current) return;
    stopRequestedRef.current = true;
    // Close any in-flight Segment before the splice runs — otherwise the
    // last burst of motion is lost from the Session Recording. Use the
    // current wall-clock as the close time; the segmenter converts it to
    // seconds-into-Master via the shared `toMasterSeconds` callback.
    segmenterRef.current?.forceClose(Date.now());
    const startedAt = recordingStartedAt ?? Date.now();
    beginStopping((Date.now() - startedAt) / 1000);
    const sid = useSessionStore.getState().currentSessionId;
    if (sid != null) {
      try {
        markStopping(sid);
      } catch (e: any) {
        console.warn('[RecordingScreen] markStopping failed', e?.message ?? e);
      }
    }
    try {
      await recorderRef.current.stopRecording();
      // Splice + Photos save runs in onMasterFinished once VisionCamera
      // hands back the Master URI.
    } catch (e: any) {
      finishWithError(`stopRecording: ${e?.message ?? e}`);
    }
  };

  const onSkipCalibration = () => {
    skipCalibration();
    const sid = useSessionStore.getState().currentSessionId;
    if (sid != null) {
      try {
        markFixedThreshold(sid);
      } catch (e: any) {
        console.warn('[RecordingScreen] markFixedThreshold failed', e?.message ?? e);
      }
    }
  };

  // Keep the screen awake for the entire RecordingScreen lifetime
  // (ADR-0002 — if the OS locks the screen, the AVCaptureSession dies
  // and the Master file is cut off; we must avoid getting interrupted
  // by our own idle timer). The Setup and Done screens don't need
  // this so we toggle it on the screen we actually want awake.
  useEffect(() => {
    setIdleTimerDisabled(true).catch(e =>
      console.warn('[RecordingScreen] setIdleTimerDisabled true failed', e?.message ?? e),
    );
    return () => {
      setIdleTimerDisabled(false).catch(e =>
        console.warn('[RecordingScreen] setIdleTimerDisabled false failed', e?.message ?? e),
      );
    };
  }, []);

  // Backgrounding kills the AVCaptureSession on iOS (ADR-0002), so we
  // trigger the same Stop path the user would tap. If the splice
  // completes before the OS suspends us, the Session lands in Photos
  // normally; otherwise the M5 recovery sweep finishes the job on
  // next launch. Either way the user doesn't lose footage.
  //
  // The listener is captured in a ref to avoid stale closures — onStop
  // closes over a bunch of store actions that the React Native
  // AppState listener wouldn't see updates to otherwise.
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  useEffect(() => {
    const handle = (status: AppStateStatus) => {
      if (status !== 'background') return;
      console.log('[RecordingScreen] AppState → background, stopping Session');
      onStopRef.current();
    };
    const sub = AppState.addEventListener('change', handle);
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.root}>
      {device ? (
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          outputs={[videoOutput, frameOutput]}
          isActive
          onPreviewStarted={() => {
            console.log('[RecordingScreen] preview started');
            setPreviewStarted(true);
          }}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.cameraFallback]}>
          <Text style={styles.cameraFallbackText}>
            No back camera available
          </Text>
        </View>
      )}
      {roi && (
        <CourtRoiOverlay
          roi={roi}
          mode={sessionState === 'Capturing' ? 'capturing' : 'stroke'}
        />
      )}
      <View style={styles.topRow} pointerEvents="box-none">
        <StateChip
          state={sessionState}
          fixedThreshold={useFixedThreshold}
        />
        <MotionBars motion={motionScore} />
      </View>
      {sessionState === 'Calibrating' && (
        <CalibratingPanel
          recordingStartedAt={recordingStartedAt}
          onSkip={onSkipCalibration}
        />
      )}
      {sessionState === 'Stopping' ? (
        <StoppingPanel />
      ) : (
        <StopFab onPress={onStop} />
      )}
    </View>
  );
}

function CalibratingPanel({
  recordingStartedAt,
  onSkip,
}: {
  recordingStartedAt: number | null;
  onSkip: () => void;
}) {
  // Tick once a second so the countdown stays roughly accurate without
  // pinning a high-frequency render loop. Off by ≤1s, which is fine for
  // a 15-second indicator.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedMs =
    recordingStartedAt != null ? Date.now() - recordingStartedAt : 0;
  const remainingMs = Math.max(0, CALIBRATION_DURATION_MS - elapsedMs);
  const remainingS = Math.ceil(remainingMs / 1000);
  return (
    <View style={styles.calibratingPanel} pointerEvents="box-none">
      <Text style={styles.calibratingText}>
        Learning what idle looks like… {remainingS}s
      </Text>
      <Pressable
        style={styles.skipBtn}
        onPress={onSkip}
        accessibilityRole="button"
        accessibilityLabel="Skip calibration"
        accessibilityHint="Falls back to fixed-threshold detection (reduced accuracy)">
        <Text style={styles.skipBtnText}>Skip calibration</Text>
      </Pressable>
    </View>
  );
}

async function startRecording(
  videoOutput: CameraVideoOutput,
  recorderRef: React.MutableRefObject<Awaited<
    ReturnType<CameraVideoOutput['createRecorder']>
  > | null>,
  onCreated: (masterUri: string) => void,
  onStarted: () => void,
  onFinish: (masterUri: string) => void,
  onError: (message: string) => void,
) {
  let recorder: Awaited<ReturnType<CameraVideoOutput['createRecorder']>>;
  try {
    recorder = await videoOutput.createRecorder({});
    recorderRef.current = recorder;
    // The Master file path is known at createRecorder time (VisionCamera
    // reserves a tempURL up-front) — capture it now so M5's persistence
    // layer can attach the URI before recording even starts. That keeps
    // crash recovery viable for very-early crashes (the file may not
    // yet exist; recovery's fileExists check handles that).
    onCreated(recorder.filePath);
    console.log('[RecordingScreen] recorder created, starting…', recorder.filePath);
  } catch (e: any) {
    console.warn('[RecordingScreen] createRecorder failed', e?.message ?? e);
    onError(`createRecorder: ${e?.message ?? e}`);
    return;
  }
  try {
    await recorder.startRecording(
      (filePath: string) => onFinish(filePath),
      (err: Error) => {
        console.warn('[RecordingScreen] recorder error', err.message);
        onError(`recorder: ${err.message}`);
      },
    );
    // VisionCamera resolves startRecording() when the recorder reports
    // its onRecordingStarted callback — i.e., from this point on the
    // Master is actually accumulating frames. M3 uses this as the time
    // origin for ActiveSegmentRecord offsets.
    console.log('[RecordingScreen] recorder writing frames');
    onStarted();
  } catch (e: any) {
    console.warn('[RecordingScreen] startRecording failed', e?.message ?? e);
    onError(`startRecording: ${e?.message ?? e}`);
  }
}

async function onMasterFinished(
  masterUri: string,
  sessionId: number | null,
  recordingStartedAt: number | null,
  segments: ActiveSegmentRecord[],
  usedFixedThreshold: boolean,
  finishWithSuccess: (info: DoneInfo) => void,
  finishWithError: (message: string) => void,
) {
  const masterDurationS =
    recordingStartedAt != null ? (Date.now() - recordingStartedAt) / 1000 : 0;
  console.log('[RecordingScreen] master finished', {
    masterUri,
    masterDurationS,
    segmentCount: segments.length,
  });

  if (segments.length === 0) {
    finishWithError(
      `No motion was detected inside the Court ROI during this Session, so there's nothing to splice. (Master kept at ${masterUri}. Try lowering START_THRESHOLD in src/detection/config.ts, or check that the ROI covers actual play.)`,
    );
    return;
  }

  const spliceSegments: ActiveSegment[] = segments.map(s => ({
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
  }));

  try {
    const result = await splice(masterUri, spliceSegments);
    console.log('[RecordingScreen] splice ok', result);
    // iOS Add-Only photo-library permission must be requested explicitly;
    // without the prompt, saveAsset rejects with an opaque "Unknown error".
    const perm = await iosRequestAddOnlyGalleryPermission();
    let sessionPhotosId: string | null = null;
    let masterPhotosId: string | null = null;
    if (perm !== 'granted' && perm !== 'limited') {
      const denied = `(photos permission: ${perm} — enable in Settings → Active Sportz → Photos)`;
      sessionPhotosId = denied;
      masterPhotosId = denied;
    } else {
      sessionPhotosId = await saveToPhotos(result.outputUri);
      // Dev-only convenience: mirror the Master into Photos so we can
      // eyeball Master vs Session side-by-side while iterating on
      // detection (M3–M4). Production (ADR-0007) keeps the Master in
      // the app sandbox; M5 will add the in-app "My Sessions" library
      // with user-controlled retention and this branch goes away.
      if (__DEV__) {
        masterPhotosId = await saveToPhotos(masterUri);
      }
    }
    if (sessionId != null) {
      try {
        markDone({
          sessionId,
          sessionUri: result.outputUri,
          endedAtMs: Date.now(),
        });
      } catch (e: any) {
        console.warn('[RecordingScreen] markDone failed', e?.message ?? e);
      }
    }
    finishWithSuccess({
      masterUri,
      masterDurationS,
      sessionUri: result.outputUri,
      spliceMs: result.spliceMs,
      outputDurationMs: result.durationMs,
      sessionPhotosId,
      masterPhotosId,
      segments,
      usedFixedThreshold,
    });
  } catch (e: any) {
    const message = `splice: ${e?.message ?? e}`;
    console.warn('[RecordingScreen] splice failed', message);
    finishWithError(message);
  }
}

// PHPhotoLibrary accepts file URLs; some platforms reject `file://` prefixes,
// so try both and surface whichever failed if both do.
async function saveToPhotos(uri: string): Promise<string> {
  try {
    const saved = await CameraRoll.saveAsset(uri, { type: 'video' });
    return saved.node?.id ?? saved.node?.image?.uri ?? '(saved)';
  } catch (e1: any) {
    const barePath = uri.replace(/^file:\/\//, '');
    try {
      const saved = await CameraRoll.saveAsset(barePath, { type: 'video' });
      return (
        saved.node?.id ??
        saved.node?.image?.uri ??
        '(saved via bare path)'
      );
    } catch (e2: any) {
      return `(save failed: ${e1?.message ?? e1} / ${e2?.message ?? e2})`;
    }
  }
}

function StateChip({
  state,
  fixedThreshold,
}: {
  state: SessionState;
  fixedThreshold: boolean;
}) {
  return (
    <View style={[styles.chip, { backgroundColor: colorForState(state) }]}>
      <View style={styles.chipDot} />
      <Text style={styles.chipText}>{state}</Text>
      {fixedThreshold && <Text style={styles.chipBadge}>fixed</Text>}
    </View>
  );
}

// Bars are driven by `motionScore` (0..1). The Frame Processor pushes
// updates via runOnJS at SCORE_EMIT_EVERY_N_FRAMES cadence.
function MotionBars({ motion }: { motion: number }) {
  return (
    <View style={styles.bars}>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <Bar key={i} index={i} motion={motion} />
      ))}
    </View>
  );
}

function Bar({ index, motion }: { index: number; motion: number }) {
  const fill = Math.max(0, Math.min(1, motion * BAR_COUNT - index));
  const targetHeight = BAR_MIN + (BAR_MAX - BAR_MIN) * fill;
  const targetOpacity = 0.25 + 0.75 * fill;

  const heightAnim = useRef(new Animated.Value(targetHeight)).current;
  const opacityAnim = useRef(new Animated.Value(targetOpacity)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(heightAnim, {
        toValue: targetHeight,
        duration: motionTokens.normal,
        useNativeDriver: false,
      }),
      Animated.timing(opacityAnim, {
        toValue: targetOpacity,
        duration: motionTokens.normal,
        useNativeDriver: false,
      }),
    ]).start();
  }, [targetHeight, targetOpacity, heightAnim, opacityAnim]);

  return (
    <Animated.View
      style={[
        styles.bar,
        {
          height: heightAnim,
          opacity: opacityAnim,
          backgroundColor: barColor(index),
        },
      ]}
    />
  );
}

function barColor(index: number): string {
  if (index <= 1) return colors.stateSoft.watching;
  if (index <= 3) return colors.stateSoft.calibrating;
  return colors.state.capturing;
}

function StopFab({ onPress }: { onPress: () => void }) {
  return (
    <>
      <Pressable
        style={[styles.fab, { backgroundColor: colors.actionStop }]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Stop session"
      />
      <Text style={[styles.fabLabel, { color: colors.actionStop }]}>STOP</Text>
    </>
  );
}

function StoppingPanel() {
  return (
    <View style={styles.stoppingPanel} pointerEvents="none">
      <ActivityIndicator color={colors.text} size="large" />
      <Text style={styles.stoppingText}>Stopping… stitching your video</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  cameraFallback: {
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraFallbackText: { color: colors.textMuted, fontSize: 14 },
  topRow: {
    position: 'absolute',
    top: 60,
    left: spacing.base,
    right: spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
  },
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.text,
  },
  chipText: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 13,
  },
  chipBadge: {
    ...typography.caption,
    color: colors.text,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.sm,
    marginLeft: spacing.xs,
    fontSize: 10,
    textTransform: 'uppercase',
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  bar: { width: 5, borderRadius: 2 },
  fab: {
    position: 'absolute',
    right: spacing.xl,
    bottom: 128,
    width: 64,
    height: 64,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.text,
    shadowColor: colors.shadow,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  fabLabel: {
    position: 'absolute',
    right: spacing.xl,
    bottom: 108,
    width: 64,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    ...overlayShadow,
  },
  stoppingPanel: {
    position: 'absolute',
    left: spacing.base,
    right: spacing.base,
    bottom: 100,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    gap: spacing.md,
  },
  stoppingText: {
    ...typography.bodyEmphasis,
    color: colors.text,
  },
  calibratingPanel: {
    position: 'absolute',
    left: spacing.base,
    right: spacing.base,
    top: 116,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    gap: spacing.sm,
  },
  calibratingText: {
    ...typography.body,
    color: colors.text,
    fontSize: 13,
  },
  skipBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSubtle,
  },
  skipBtnText: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    textTransform: 'uppercase',
  },
});
