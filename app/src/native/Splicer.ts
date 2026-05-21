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
};

const native = NativeModules.Splicer as SplicerNative | undefined;

export async function splice(
  masterUri: string,
  segments: ActiveSegment[],
): Promise<SpliceResult> {
  if (!native) {
    throw new Error(
      'Splicer native module is not linked. Rebuild the iOS app after adding Splicer.swift/SplicerBridge.mm.',
    );
  }
  if (segments.length === 0) {
    throw new Error('splice() requires at least one segment');
  }
  return native.splice(masterUri, segments);
}
