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
  AppState,
  type AppStateStatus,
} from 'react-native';
import {
  Camera,
  CommonResolutions,
  useCameraDevices,
  usePhotoOutput,
  useVideoOutput,
  type CameraVideoOutput,
} from 'react-native-vision-camera';
import {
  CameraRoll,
  iosRequestAddOnlyGalleryPermission,
} from '@react-native-camera-roll/camera-roll';
import {
  fileExists,
  getDeviceMotionMagnitude,
  getSpliceProgress,
  getThermalState,
  scheduleLocalNotification,
  setIdleTimerDisabled,
  splice,
  startMotionUpdates,
  stopMotionUpdates,
  type ActiveSegment,
  type ThermalState,
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
import { usePersonFrameOutput } from '../detection/personFrameProcessor';
import { Segmenter } from '../detection/segmenter';
import {
  END_THRESHOLD,
  START_THRESHOLD,
} from '../detection/config';
import {
  attachMasterUri,
  markDone,
  markDoneRecovered,
  markFixedThreshold,
  markStopping,
} from '../persistence/sessionRepo';
import { appendSegment } from '../persistence/segmentRepo';
import {
  useSettingsStore,
  labelForMode,
  effectiveThresholds,
} from '../state/settingsStore';

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

  // Photo output for the in-app Snapshot button. iOS AVCaptureSession
  // supports photo + video outputs simultaneously, so this coexists
  // with the recorder. Quality 'balanced' keeps capture latency low
  // (full 'quality' triggers HDR multi-frame fusion which can hitch
  // the recording for a frame or two). Mounted unconditionally — the
  // Snapshot button is the only thing that drives it; we pay no cost
  // when it isn't pressed.
  const photoOutput = usePhotoOutput({
    qualityPrioritization: 'balanced',
  });

  // Snapshot UX state: a brief check-flash after a successful save so
  // the user knows the still landed in Photos without having to leave
  // the Recording screen. Auto-clears after a beat.
  const [snapshotFlash, setSnapshotFlash] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');

  const sessionState = useSessionStore(s => s.sessionState);
  const recordingStartedAt = useSessionStore(s => s.recordingStartedAt);
  const roi = useSessionStore(s => s.roi);
  // Setup-frozen pinch-zoom factor (decisions-log: "Pinch-to-zoom at
  // Setup"). Applied to the Camera so the Frame Processor sees the
  // same framing the user chose during Setup. Reads the live store
  // value — `reset()` restores it to 1, and SetupScreen doesn't touch
  // it after Auto Record, so the value is effectively frozen for the
  // Session without needing a separate snapshot.
  const setupZoom = useSessionStore(s => s.setupZoom);
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

  // M7 polish state: splice progress for the Stopping screen, thermal
  // pressure for an in-Session warning badge.
  const [spliceProgress, setSpliceProgress] = useState(0);
  const [thermalState, setThermalState] = useState<ThermalState>('nominal');

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
    // Resolve user-overridden thresholds at construction so they're
    // captured for the Session's lifetime. Settings changes mid-Session
    // intentionally don't reach the Segmenter — keeps the trigger
    // contract stable per Session (ADR-0009).
    const thresholds = effectiveThresholds(useSettingsStore.getState());
    segmenterRef.current = new Segmenter(
      {
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
      },
      thresholds,
    );
  }

  // Detection Mode is locked at Auto Record (read from Settings; the
  // Session row was already stamped with this value in SetupScreen). We
  // capture it once here per Session via `useRef`-of-snapshot so a user
  // flipping the Settings toggle mid-Session does not change the
  // pipeline mid-Session (ADR-0009).
  const detectionMode = useSettingsStore(s => s.detectionMode);
  const sessionModeRef = useRef(detectionMode);
  useEffect(() => {
    // Refresh only while the Session has not started yet; once we're
    // recording, freeze the value.
    if (sessionState === 'Setup') {
      sessionModeRef.current = detectionMode;
    }
  }, [detectionMode, sessionState]);
  const isPlayersMode = sessionModeRef.current === 'players';

  // The Frame Processor's per-frame onScore runs on JS (via runOnJS).
  // We update the motion-bar UI and feed the Segmenter — both cheap.
  const onScore = (score: number, atMs: number) => {
    setMotionScore(score);
    segmenterRef.current?.onScore(score, atMs);
  };

  // Latest person count from the person-detector worklet (Enhanced
  // Mode only). Mirrored from the Segmenter's internal counter so the
  // dev diagnostics HUD can render it without exposing private state.
  const [lastPersonCount, setLastPersonCount] = useState<number | null>(
    null,
  );

  // The person-detector worklet's tick (when 'players' Mode is active).
  // Just keeps the Segmenter's latest person-count fresh; the gate is
  // checked at open-confirmation time. In 'motion' Mode this is never
  // called and `lastPersonCount` stays null inside the Segmenter,
  // collapsing the player gate to "always open".
  const onPersonCount = (count: number, _atMs: number) => {
    segmenterRef.current?.setPersonCount(count);
    setLastPersonCount(count);
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
  // Mount the person-detector worklet only when Mode = 'players'. Hooks
  // must be called unconditionally, so we always call the hook and rely
  // on conditional inclusion in the Camera's `outputs` array below.
  // Passing `roi: null` when the mode is 'motion' makes the worklet a
  // no-op — its onFrame returns immediately.
  const personFrameOutput = usePersonFrameOutput({
    roi: isPlayersMode ? roi : null,
    onPersonCount,
  });

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
          null, // recoveryReason — clean finish
          sessionModeRef.current === 'continuous',
        );
      },
      // Recorder-error recovery path. AVFoundation often reports
      // `AVErrorRecordingSuccessfullyFinishedKey=true` on -11818 under
      // thermal pressure or screenshot interruptions — the Master file
      // is finalized on disk even though the SDK surfaces an error. If
      // we have a path, route through onMasterFinished with a recovery
      // note so the splice + Photos save still runs. If the file is
      // missing or recorderRef has no path yet (early failure), surface
      // a hard error via finishWithError.
      (message: string) => {
        const path = recorderRef.current?.filePath ?? null;
        const final = useSessionStore.getState();
        if (path == null) {
          finishWithError(message);
          return;
        }
        const recoveryReason =
          'The recorder ended unexpectedly (likely thermal pressure or a screenshot interrupting AVFoundation). Your recording was preserved up to that point.';
        // Make sure any open Segment is flushed so partial play isn't
        // lost from the splice when we recover from an unexpected stop.
        segmenterRef.current?.forceClose(Date.now());
        const segmentsAtError = useSessionStore.getState().segments;
        console.warn(
          '[RecordingScreen] recovering Master after recorder error',
          { path, segments: segmentsAtError.length, message },
        );
        onMasterFinished(
          path,
          final.currentSessionId,
          recordingStartedAt,
          segmentsAtError,
          final.useFixedThreshold,
          finishWithSuccess,
          finishWithError,
          `${recoveryReason} (Underlying error: ${message})`,
          sessionModeRef.current === 'continuous',
        );
      },
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

  // In-app frame snapshot. Avoids iOS screenshot mid-Session (which has
  // correlated with AVFoundation -11818 errors under thermal pressure)
  // and writes the captured still to Photos so the user can share it
  // without leaving the recording flow.
  //
  // Pipeline: photoOutput.capturePhoto → saveToTemporaryFileAsync
  // returns a filesystem path → CameraRoll.saveAsset under the photo
  // type → photo.dispose() releases native buffers. The recorder
  // continues uninterrupted (AVCaptureSession supports photo + video
  // outputs simultaneously on iOS).
  const onSnapshot = async () => {
    if (snapshotFlash === 'saving') return;
    setSnapshotFlash('saving');
    let photo: Awaited<ReturnType<typeof photoOutput.capturePhoto>> | null =
      null;
    try {
      const perm = await iosRequestAddOnlyGalleryPermission();
      if (perm !== 'granted' && perm !== 'limited') {
        console.warn('[RecordingScreen] snapshot: photos permission', perm);
        setSnapshotFlash('error');
        setTimeout(() => setSnapshotFlash('idle'), 1500);
        return;
      }
      photo = await photoOutput.capturePhoto({}, {});
      const filesystemPath = await photo.saveToTemporaryFileAsync();
      await CameraRoll.saveAsset(`file://${filesystemPath}`, { type: 'photo' });
      setSnapshotFlash('saved');
      setTimeout(() => setSnapshotFlash('idle'), 1200);
    } catch (e: any) {
      console.warn('[RecordingScreen] snapshot failed', e?.message ?? e);
      setSnapshotFlash('error');
      setTimeout(() => setSnapshotFlash('idle'), 1500);
    } finally {
      photo?.dispose();
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
      // Best-effort: schedule a local notification so the user sees that
      // the OS interruption was handled even before they reopen the app.
      // If permission is denied this just no-ops.
      scheduleLocalNotification(
        'Session ended early',
        'Active Sportz backgrounded — your recording is being saved.',
      ).catch(e =>
        console.warn('[RecordingScreen] scheduleLocalNotification failed', e?.message ?? e),
      );
      onStopRef.current();
    };
    const sub = AppState.addEventListener('change', handle);
    return () => sub.remove();
  }, []);

  // Poll splice progress while Stopping so the user sees forward motion
  // rather than a hung spinner. Cheap: native getter just reads
  // exporter.progress; no allocation per tick.
  useEffect(() => {
    if (sessionState !== 'Stopping') {
      setSpliceProgress(0);
      return;
    }
    const t = setInterval(() => {
      getSpliceProgress()
        .then(setSpliceProgress)
        .catch(() => {});
    }, 100);
    return () => clearInterval(t);
  }, [sessionState]);

  // Sample thermal state once a minute while the screen is up. We don't
  // need higher resolution — thermal pressure builds over minutes, not
  // frames, and a heavier cadence would waste battery for no UX gain.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getThermalState();
        if (!cancelled) setThermalState(s);
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Handheld guardrail (T28 / ADR-0009 / decisions-log "Known
  // limitation — handheld false-positive"). Poll the CMDeviceMotion
  // magnitude every 200ms, apply hysteresis around a 0.04 g band
  // (stable < 0.025, unstable > 0.055 — between is "no change"), and
  // feed the result to the Segmenter so handheld micro-shake doesn't
  // open Active Segments. Skipped entirely in Continuous Mode (no
  // detector) and on devices without an IMU (Simulator).
  const [deviceUnstable, setDeviceUnstable] = useState(false);
  useEffect(() => {
    if (sessionModeRef.current === 'continuous') return;
    let cancelled = false;
    let started = false;
    let unstableState = false;
    const STABLE_THRESHOLD = 0.025; // below this → stable
    const UNSTABLE_THRESHOLD = 0.055; // above this → unstable
    const tick = async () => {
      try {
        const mag = await getDeviceMotionMagnitude();
        if (cancelled) return;
        // Hysteresis: only flip state when the magnitude crosses the
        // far side of the band. This avoids flickering between the
        // two states from small reading-to-reading noise.
        const next = unstableState
          ? mag > STABLE_THRESHOLD
          : mag > UNSTABLE_THRESHOLD;
        if (next !== unstableState) {
          unstableState = next;
          setDeviceUnstable(next);
          segmenterRef.current?.setDeviceUnstable(next);
        }
      } catch {
        /* ignore */
      }
    };
    (async () => {
      try {
        started = await startMotionUpdates();
        if (cancelled) {
          if (started) await stopMotionUpdates();
          return;
        }
      } catch {
        started = false;
      }
      if (!started) return; // Simulator or unsupported device — skip the loop
    })();
    const t = setInterval(tick, 200);
    return () => {
      cancelled = true;
      clearInterval(t);
      stopMotionUpdates().catch(() => {});
    };
  }, []);

  return (
    <View style={styles.root}>
      {device ? (
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          outputs={
            isPlayersMode
              ? [videoOutput, frameOutput, personFrameOutput, photoOutput]
              : [videoOutput, frameOutput, photoOutput]
          }
          isActive
          zoom={setupZoom}
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
        {__DEV__ && (
          <DiagnosticsHud
            motionScore={motionScore}
            mode={sessionModeRef.current}
            isPlayersMode={isPlayersMode}
            lastPersonCount={lastPersonCount}
          />
        )}
      </View>
      {thermalState === 'critical' && (
        <View style={styles.thermalBanner} pointerEvents="none">
          <Text style={styles.thermalBannerText}>
            iPhone is running hot (critical). The OS may downgrade
            camera quality soon — plug in or move to a cooler spot.
            Recording continues.
          </Text>
        </View>
      )}
      {thermalState === 'serious' && (
        <View style={styles.thermalPill} pointerEvents="none">
          <Text style={styles.thermalPillText}>system: warm</Text>
        </View>
      )}
      {/* Handheld guardrail banner. Only meaningful while a detector
          is active — Continuous Mode skips the IMU polling so this
          stays hidden, but defensively we also gate on the mode. */}
      {deviceUnstable && sessionModeRef.current !== 'continuous' && (
        <View style={styles.unstableBanner} pointerEvents="none">
          <Text style={styles.unstableBannerText}>
            Phone is moving — put it on a stand. Auto Record is
            paused until the camera holds still.
          </Text>
        </View>
      )}
      {sessionState !== 'Stopping' && (
        <Text style={styles.lockHint} pointerEvents="none">
          Keep the phone awake — locking ends the Session.
        </Text>
      )}
      {sessionState === 'Calibrating' && (
        <CalibratingPanel
          recordingStartedAt={recordingStartedAt}
          onSkip={onSkipCalibration}
        />
      )}
      {sessionState === 'Stopping' ? (
        <StoppingPanel progress={spliceProgress} />
      ) : (
        <StopFab onPress={onStop} />
      )}
      {/* In-app Snapshot button — bottom-left mirror of the Stop FAB.
          Shown only while recording (Watching / Capturing); hidden in
          Calibrating to keep that screen focused, and during Stopping
          since the photoOutput is about to be torn down. */}
      {(sessionState === 'Watching' || sessionState === 'Capturing') && (
        <SnapshotFab onPress={onSnapshot} flash={snapshotFlash} />
      )}
    </View>
  );
}

function SnapshotFab({
  onPress,
  flash,
}: {
  onPress: () => void;
  flash: 'idle' | 'saving' | 'saved' | 'error';
}) {
  const disabled = flash === 'saving';
  const bg =
    flash === 'saved'
      ? colors.stateSoft.done
      : flash === 'error'
        ? colors.stateSoft.capturing
        : colors.surface;
  const label =
    flash === 'saved'
      ? '✓ SAVED'
      : flash === 'error'
        ? '× FAILED'
        : flash === 'saving'
          ? '…'
          : '📷';
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[
        styles.snapshotFab,
        { backgroundColor: bg },
        disabled && styles.snapshotFabDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel="Capture a still frame and save to Photos">
      <Text style={styles.snapshotFabLabel}>{label}</Text>
    </Pressable>
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
        accessibilityLabel="Skip Warm-up"
        accessibilityHint="Falls back to fixed-threshold detection (reduced accuracy)">
        <Text style={styles.skipBtnText}>Skip Warm-up</Text>
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
  // When set, the Master arrived via the recorder-error recovery path
  // rather than a clean stopRecording. The note is surfaced on Done so
  // the user knows what happened *and* that the Master was preserved.
  // The splice + Photos save still runs — partial Masters are still
  // useful and AVFoundation often reports
  // `AVErrorRecordingSuccessfullyFinishedKey=true` alongside the error.
  recoveryReason: string | null = null,
  // True when the Session ran in Continuous Mode. The Master is the
  // user-facing artifact — save it directly to Photos (production
  // builds included), skip the splice entirely, and surface the Done
  // screen as a clean success rather than a recovery.
  continuousMode: boolean = false,
) {
  const masterDurationS =
    recordingStartedAt != null ? (Date.now() - recordingStartedAt) / 1000 : 0;
  console.log('[RecordingScreen] master finished', {
    masterUri,
    masterDurationS,
    segmentCount: segments.length,
    recovery: recoveryReason,
    continuous: continuousMode,
  });

  // If we have *no* file on disk there's nothing to recover — surface a
  // hard error and bail. Otherwise every downstream branch attempts to
  // preserve the Master via Photos (dev) and mark the DB row 'done' so
  // the in-app Library can surface it.
  const masterExists = await fileExists(masterUri).catch(() => false);
  if (!masterExists) {
    finishWithError(
      recoveryReason
        ? `${recoveryReason} (Master file missing at ${masterUri}; nothing to recover.)`
        : `Master file missing at ${masterUri}.`,
    );
    return;
  }

  // Save the Master to Photos *first*, before any splice attempt, so a
  // splice failure or thermal interruption can't strand the recording.
  // In production builds Photos normally only gets the Session
  // Recording per ADR-0007; in __DEV__ we mirror the Master too for
  // visual diffing. In Continuous Mode the Master *is* the user-facing
  // artifact (no splice runs), so we save it in production too.
  const perm = await iosRequestAddOnlyGalleryPermission();
  const photosPermOk = perm === 'granted' || perm === 'limited';
  const photosPermDenied = photosPermOk
    ? null
    : `(photos permission: ${perm} — enable in Settings → Active Sportz → Photos)`;
  const shouldMirrorMasterToPhotos = __DEV__ || continuousMode;
  let masterPhotosId: string | null = null;
  if (shouldMirrorMasterToPhotos && photosPermOk) {
    try {
      masterPhotosId = await saveToPhotos(masterUri);
    } catch (e: any) {
      console.warn('[RecordingScreen] saveToPhotos(master) failed', e?.message ?? e);
      masterPhotosId = `(save failed: ${e?.message ?? e})`;
    }
  } else if (shouldMirrorMasterToPhotos) {
    masterPhotosId = photosPermDenied;
  }

  // Continuous Mode: the Master is the Session. No splice, no Active
  // Segments. Mark the DB row done with `session_uri = master_uri` so
  // the Library renders it as a complete entry (not a "(missing)"
  // recovery), and land on a clean Done screen.
  if (continuousMode) {
    if (sessionId != null) {
      try {
        markDone({
          sessionId,
          sessionUri: masterUri,
          endedAtMs: Date.now(),
        });
      } catch (e: any) {
        console.warn('[RecordingScreen] markDone(continuous) failed', e?.message ?? e);
      }
    }
    finishWithSuccess({
      masterUri,
      masterDurationS,
      sessionUri: masterUri,
      spliceMs: 0,
      outputDurationMs: masterDurationS * 1000,
      sessionPhotosId: masterPhotosId,
      masterPhotosId,
      segments,
      usedFixedThreshold,
      recoveryNote: null,
    });
    return;
  }

  // No segments → no splice possible. Land on the Done screen with the
  // Master preserved (sessionUri stays null; the Library renders these
  // as "Master only" entries). Mark the DB row 'done' via the recovery
  // marker so listDone() finds it.
  if (segments.length === 0) {
    if (sessionId != null) {
      try {
        markDoneRecovered({ sessionId, endedAtMs: Date.now() });
      } catch (e: any) {
        console.warn('[RecordingScreen] markDoneRecovered failed', e?.message ?? e);
      }
    }
    finishWithSuccess({
      masterUri,
      masterDurationS,
      sessionUri: null,
      spliceMs: 0,
      outputDurationMs: 0,
      sessionPhotosId: null,
      masterPhotosId,
      segments,
      usedFixedThreshold,
      recoveryNote:
        recoveryReason ??
        'No motion was detected inside the Court ROI, so no Session Recording was produced. Your Master Recording is preserved.',
    });
    return;
  }

  const spliceSegments: ActiveSegment[] = segments.map(s => ({
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
  }));

  try {
    const result = await splice(masterUri, spliceSegments);
    console.log('[RecordingScreen] splice ok', result);
    let sessionPhotosId: string | null = null;
    if (!photosPermOk) {
      sessionPhotosId = photosPermDenied;
    } else {
      try {
        sessionPhotosId = await saveToPhotos(result.outputUri);
      } catch (e: any) {
        console.warn('[RecordingScreen] saveToPhotos(session) failed', e?.message ?? e);
        sessionPhotosId = `(save failed: ${e?.message ?? e})`;
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
      recoveryNote: recoveryReason,
    });
  } catch (e: any) {
    // Splice failed but the Master is on disk and already saved to
    // Photos (in __DEV__). Land on Done with the Master preserved
    // and the splice error surfaced as the recovery note so the user
    // sees what happened.
    const spliceErr = `splice: ${e?.message ?? e}`;
    console.warn('[RecordingScreen] splice failed', spliceErr);
    if (sessionId != null) {
      try {
        markDoneRecovered({ sessionId, endedAtMs: Date.now() });
      } catch (innerE: any) {
        console.warn('[RecordingScreen] markDoneRecovered failed', innerE?.message ?? innerE);
      }
    }
    finishWithSuccess({
      masterUri,
      masterDurationS,
      sessionUri: null,
      spliceMs: 0,
      outputDurationMs: 0,
      sessionPhotosId: null,
      masterPhotosId,
      segments,
      usedFixedThreshold,
      recoveryNote: recoveryReason
        ? `${recoveryReason} Splice also failed: ${spliceErr}`
        : `Splice failed (${spliceErr}). Your Master Recording is preserved.`,
    });
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

/**
 * Dev-only diagnostics HUD shown next to the motion bars. Surfaces:
 *   - Live motion score against the START / END thresholds.
 *   - Active Detection Mode (Smart / Enhanced).
 *   - Latest person count when Enhanced Mode is on (`–` if the
 *     person-detector worklet is still on the no-op shim awaiting
 *     the bake-off model).
 *
 * Visible in `__DEV__` builds only. Renders as a small monospaced
 * card so the visual weight stays low — the motion-bar column above
 * remains the primary "we see motion" signal for parents.
 */
function DiagnosticsHud({
  motionScore,
  mode,
  isPlayersMode,
  lastPersonCount,
}: {
  motionScore: number;
  mode: 'motion' | 'players' | 'continuous';
  isPlayersMode: boolean;
  lastPersonCount: number | null;
}) {
  const aboveStart = motionScore >= START_THRESHOLD;
  const aboveEnd = motionScore >= END_THRESHOLD;
  const scoreColor = aboveStart
    ? colors.actionStop // warm — score is high enough to OPEN
    : aboveEnd
      ? colors.stateSoft.calibrating // amber — between thresholds
      : colors.textSubtle;
  return (
    <View style={styles.hud} pointerEvents="none">
      <Text style={[styles.hudKey, { color: colors.textSubtle }]}>score</Text>
      <Text style={[styles.hudVal, { color: scoreColor }]}>
        {motionScore.toFixed(3)}
      </Text>
      <Text style={styles.hudThresh}>
        ↑{START_THRESHOLD.toFixed(2)} ↓{END_THRESHOLD.toFixed(2)}
      </Text>
      <Text style={styles.hudKey}>mode</Text>
      <Text style={styles.hudVal}>{labelForMode(mode)}</Text>
      {isPlayersMode && (
        <>
          <Text style={styles.hudKey}>players</Text>
          <Text style={styles.hudVal}>
            {lastPersonCount == null ? '–' : `${lastPersonCount}`}
          </Text>
        </>
      )}
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

function StoppingPanel({ progress }: { progress: number }) {
  // `progress` is 0..1. Clamp + format for display; the native getter
  // never returns negatives but the initial sub-100ms tick will show
  // "Preparing…" before the first progress sample arrives.
  const pct = Math.max(0, Math.min(1, progress));
  return (
    <View style={styles.stoppingPanel} pointerEvents="none">
      <Text style={styles.stoppingText}>Stopping… stitching your video</Text>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: (`${(pct * 100).toFixed(1)}%`) as `${number}%` },
          ]}
        />
      </View>
      <Text style={styles.progressLabel}>
        {pct === 0 ? 'Preparing…' : `${Math.round(pct * 100)}%`}
      </Text>
      <Text style={styles.stoppingHint}>
        Keep the phone awake — locking will interrupt the save.
      </Text>
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
  snapshotFab: {
    position: 'absolute',
    left: spacing.xl,
    bottom: 128,
    minWidth: 64,
    height: 56,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.text,
    shadowColor: colors.shadow,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  snapshotFabDisabled: { opacity: 0.6 },
  snapshotFabLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
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
  stoppingHint: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.actionStart,
  },
  progressLabel: {
    ...typography.mono,
    color: colors.text,
    fontSize: 13,
  },
  thermalBanner: {
    position: 'absolute',
    // Anchored to the bottom band (above the Stop / Snapshot FABs at
    // bottom: 128) so the entire top region remains available for the
    // detection UI — state chip, motion bars, lockHint, and (in dev)
    // the diagnostics HUD. The 'critical' state is rare, but when it
    // does show the user is mid-Session and the motion-feedback
    // affordances are the most important things to keep unobscured.
    bottom: 200,
    left: spacing.base,
    right: spacing.base,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.state.capturing,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thermalBannerText: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 12,
    textAlign: 'center',
  },
  // Quieter inline indicator for the iOS `'serious'` thermal state. iOS
  // reports `'serious'` aggressively when a debugger is attached or
  // screen mirroring is on, so we don't want it to be alarming. A small
  // pill near the state row tells advanced users / developers without
  // shouting at parents during a real match.
  thermalPill: {
    position: 'absolute',
    top: 64,
    left: spacing.base + 90, // sit to the right of the state pill
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thermalPillText: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 10,
  },
  // Handheld guardrail banner. Anchored above the FAB area so it
  // doesn't compete with the motion bars / diagnostics HUD at top.
  // Warm-toned (uses the Calibrating accent for "informational, not
  // an error") so it's distinct from the red thermal banner.
  unstableBanner: {
    position: 'absolute',
    bottom: 260,
    left: spacing.base,
    right: spacing.base,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.state.calibrating,
    borderWidth: 1,
    borderColor: colors.border,
  },
  unstableBannerText: {
    ...typography.bodyEmphasis,
    color: colors.text,
    fontSize: 12,
    textAlign: 'center',
  },
  hud: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-end',
    minWidth: 90,
  },
  hudKey: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  hudVal: {
    ...typography.mono,
    color: colors.text,
    fontSize: 12,
    lineHeight: 14,
  },
  hudThresh: {
    ...typography.mono,
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 11,
  },
  lockHint: {
    position: 'absolute',
    top: 96,
    left: spacing.base,
    right: spacing.base,
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 10,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 1,
    ...overlayShadow,
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
