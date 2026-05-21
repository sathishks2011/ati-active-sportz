/**
 * Typed JS wrapper around the native Splicer module (ios/ActiveSportz/Splicer.swift).
 *
 * Splices the Master Recording at `masterUri` along `segments` (in source-time
 * seconds) and writes a passthrough-copied Session Recording to a fresh file
 * in the app's caches directory. The native side uses AVMutableComposition +
 * AVAssetExportPresetPassthrough — the iOS equivalent of FFmpeg `-c copy`.
 *
 * Per ADR-0007 / decisions-log: cuts align to H.264 keyframes (~2s slop).
 * Acceptable for the MVP; pixel-perfect cuts would require re-encode.
 */

import { NativeModules } from 'react-native';

export type ActiveSegment = {
  startSeconds: number;
  endSeconds: number;
};

export type SpliceResult = {
  /** file:// URI of the produced Session Recording. */
  outputUri: string;
  /** Total duration of the spliced output, in milliseconds. */
  durationMs: number;
  /** Wall-clock time the native splice step took, in milliseconds. */
  spliceMs: number;
};

type SplicerNative = {
  splice: (
    masterPath: string,
    segments: ActiveSegment[],
  ) => Promise<SpliceResult>;
  fileExists: (path: string) => Promise<boolean>;
  deleteFile: (path: string) => Promise<boolean>;
  setIdleTimerDisabled: (disabled: boolean) => Promise<void>;
};

const native = NativeModules.Splicer as SplicerNative | undefined;

function requireNative(): SplicerNative {
  if (!native) {
    throw new Error(
      'Splicer native module is not linked. Rebuild the iOS app after adding Splicer.swift/SplicerBridge.mm.',
    );
  }
  return native;
}

export async function splice(
  masterUri: string,
  segments: ActiveSegment[],
): Promise<SpliceResult> {
  if (segments.length === 0) {
    throw new Error('splice() requires at least one segment');
  }
  return requireNative().splice(masterUri, segments);
}

/**
 * True if a file exists at the given path or file:// URI. Used by the
 * M5 crash-recovery sweep to confirm a persisted Master is still on
 * disk before attempting to splice it.
 */
export function fileExists(path: string): Promise<boolean> {
  return requireNative().fileExists(path);
}

/**
 * Deletes a file. Resolves true if a file was removed, false if it
 * was already gone. Used by the Library's "Delete Master Recording
 * (keep Session Recording)" action.
 */
export function deleteFile(path: string): Promise<boolean> {
  return requireNative().deleteFile(path);
}

/**
 * Sets `UIApplication.shared.isIdleTimerDisabled`. M6 keeps the screen
 * awake for the duration of a Session (ADR-0002 — the OS killing the
 * app to save power is the very thing we're trying to avoid).
 */
export function setIdleTimerDisabled(disabled: boolean): Promise<void> {
  return requireNative().setIdleTimerDisabled(disabled);
}
