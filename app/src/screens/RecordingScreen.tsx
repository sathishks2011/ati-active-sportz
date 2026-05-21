/**
 * Recording screen — live Session.
 *
 * Design: M0 verdict was Variant B (Smart-film chip), see decisions-log.md.
 *   - Top compact state pill on the left.
 *   - Top-right vertical motion bars (cool → warm → hot color graduation).
 *   - Court ROI rectangle; translucent warm fill only while `Capturing`.
 *   - Bottom-right FAB Stop, action color carries the state.
 *
 * Lifecycle: this screen is the one place where `Camera + useVideoOutput`
 * is bound. It mounts when `sessionMachine` is in any running state
 * (Calibrating | Watching | Capturing | Stopping). On mount it starts the
 * Master Recording; on Stop it transitions to Stopping, stops the
 * recorder, splices with M1's hardcoded segments, saves to Photos, and
 * transitions to Done.
 *
 * Detection (M3) is not wired — `motionScore` stays at 0 so the bars
 * render at their floor. State stays in Watching after Calibrating ends;
 * Capturing visuals are designed and reachable but not driven by anything
 * until motion detection lands.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  ActivityIndicator,
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
import { splice, type ActiveSegment } from '../native/Splicer';
import { CourtRoiOverlay } from '../components/CourtRoiOverlay';
import {
  CALIBRATION_DURATION_MS,
  useSessionStore,
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

// Hardcoded for M2 (carried over from M1): 5–15s and 25–40s of the Master
// become the Session. Real motion-derived segments arrive in M3. The user
// must keep the Session running long enough to include both windows or the
// later segment is clamped by AVFoundation.
const HARDCODED_SEGMENTS: ActiveSegment[] = [
  { startSeconds: 5, endSeconds: 15 },
  { startSeconds: 25, endSeconds: 40 },
];

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
  const endCalibration = useSessionStore(s => s.endCalibration);
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

  // Calibrating → Watching after the warm-up window (ADR-0006). M4 will
  // swap this fixed timeout for the adaptive-baseline-ready signal.
  useEffect(() => {
    if (sessionState !== 'Calibrating') return;
    const t = setTimeout(endCalibration, CALIBRATION_DURATION_MS);
    return () => clearTimeout(t);
  }, [sessionState, endCalibration]);

  // Start the Master Recording exactly once per Session, on the first render
  // where the camera device is available. The Setup screen has already put
  // us into Calibrating before this screen mounts.
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
        onMasterFinished(
          masterUri,
          recordingStartedAt,
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
    finishWithSuccess,
    finishWithError,
  ]);

  const onStop = async () => {
    if (stopRequestedRef.current) return;
    if (!recorderRef.current) return;
    stopRequestedRef.current = true;
    const startedAt = recordingStartedAt ?? Date.now();
    beginStopping((Date.now() - startedAt) / 1000);
    try {
      await recorderRef.current.stopRecording();
      // Splice + Photos save runs in onMasterFinished once VisionCamera
      // hands back the Master URI.
    } catch (e: any) {
      finishWithError(`stopRecording: ${e?.message ?? e}`);
    }
  };

  return (
    <View style={styles.root}>
      {device ? (
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          outputs={[videoOutput]}
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
        <StateChip state={sessionState} />
        <MotionBars motion={motionScore} />
      </View>
      {sessionState === 'Stopping' ? (
        <StoppingPanel />
      ) : (
        <StopFab onPress={onStop} />
      )}
    </View>
  );
}

async function startRecording(
  videoOutput: CameraVideoOutput,
  recorderRef: React.MutableRefObject<Awaited<
    ReturnType<CameraVideoOutput['createRecorder']>
  > | null>,
  onFinish: (masterUri: string) => void,
  onError: (message: string) => void,
) {
  let recorder: Awaited<ReturnType<CameraVideoOutput['createRecorder']>>;
  try {
    recorder = await videoOutput.createRecorder({});
    recorderRef.current = recorder;
    console.log('[RecordingScreen] recorder created, starting…');
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
  } catch (e: any) {
    console.warn('[RecordingScreen] startRecording failed', e?.message ?? e);
    onError(`startRecording: ${e?.message ?? e}`);
  }
}

async function onMasterFinished(
  masterUri: string,
  recordingStartedAt: number | null,
  finishWithSuccess: (info: import('../state/sessionMachine').DoneInfo) => void,
  finishWithError: (message: string) => void,
) {
  const masterDurationS =
    recordingStartedAt != null ? (Date.now() - recordingStartedAt) / 1000 : 0;
  console.log('[RecordingScreen] master finished', {
    masterUri,
    masterDurationS,
  });
  try {
    const result = await splice(masterUri, HARDCODED_SEGMENTS);
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
      // detection (M2–M4). Production (ADR-0007) keeps the Master in the
      // app sandbox; M5 will add the in-app "My Sessions" library with
      // user-controlled retention and this branch goes away.
      if (__DEV__) {
        masterPhotosId = await saveToPhotos(masterUri);
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
    });
  } catch (e: any) {
    const message = `splice: ${e?.message ?? e}`;
    const hint =
      masterDurationS < 40
        ? ` (master was ${masterDurationS.toFixed(1)}s; the hardcoded segments need >40s — M3 replaces this with motion-derived segments)`
        : '';
    console.warn('[RecordingScreen] splice failed', message);
    finishWithError(message + hint);
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

function StateChip({ state }: { state: SessionState }) {
  return (
    <View style={[styles.chip, { backgroundColor: colorForState(state) }]}>
      <View style={styles.chipDot} />
      <Text style={styles.chipText}>{state}</Text>
    </View>
  );
}

// Bars are driven by `motionScore` (0..1). Until M3 wires real motion
// detection this stays at 0, so all bars render at BAR_MIN and the
// surface stays calm.
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
});
