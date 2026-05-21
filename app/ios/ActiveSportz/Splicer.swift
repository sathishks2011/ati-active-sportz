// Active Sportz — Splicer native module
//
// Given a Master Recording file URI and an ordered list of Active Segment
// time ranges (seconds), produces a Session Recording that concatenates only
// those time ranges, using AVMutableComposition + AVAssetExportSession with
// the passthrough preset (no re-encode, hardware-fast, keyframe-aligned).
//
// This is the iOS equivalent of FFmpeg's `-c copy` over selected time spans.
// Implements ADR-0007's splice step. Lives in the app target so M1 can prove
// the pipeline without an external FFmpeg dependency.

import Foundation
import AVFoundation
import React

@objc(Splicer)
class Splicer: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /// Splices the master at `masterPath` using `segments` (an array of
  /// `{startSeconds, endSeconds}` dictionaries) and writes the result to a
  /// new file under the app's caches directory. Resolves with
  /// `{ outputUri, durationMs, spliceMs }`.
  @objc func splice(
    _ masterPath: String,
    segments: NSArray,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let started = CFAbsoluteTimeGetCurrent()

    let masterURL: URL = {
      if masterPath.hasPrefix("file://") {
        return URL(string: masterPath)!
      }
      return URL(fileURLWithPath: masterPath)
    }()

    guard FileManager.default.fileExists(atPath: masterURL.path) else {
      reject("E_MASTER_NOT_FOUND", "Master file not found at \(masterURL.path)", nil)
      return
    }

    let asset = AVURLAsset(url: masterURL)

    guard let assetVideoTrack = asset.tracks(withMediaType: .video).first else {
      reject("E_NO_VIDEO_TRACK", "Master has no video track", nil)
      return
    }

    let composition = AVMutableComposition()
    guard let compVideoTrack = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      reject("E_COMP_TRACK_FAILED", "Could not create composition video track", nil)
      return
    }
    compVideoTrack.preferredTransform = assetVideoTrack.preferredTransform

    var insertAt = CMTime.zero

    for raw in segments {
      guard let seg = raw as? [String: Any],
            let startSec = (seg["startSeconds"] as? NSNumber)?.doubleValue,
            let endSec = (seg["endSeconds"] as? NSNumber)?.doubleValue,
            endSec > startSec else {
        reject("E_BAD_SEGMENT", "Invalid segment: \(raw)", nil)
        return
      }
      let start = CMTime(seconds: startSec, preferredTimescale: 600)
      let end = CMTime(seconds: endSec, preferredTimescale: 600)
      let timeRange = CMTimeRange(start: start, end: end)
      do {
        try compVideoTrack.insertTimeRange(timeRange, of: assetVideoTrack, at: insertAt)
        insertAt = CMTimeAdd(insertAt, timeRange.duration)
      } catch {
        reject("E_INSERT_FAILED", "insertTimeRange failed for [\(startSec), \(endSec)]: \(error.localizedDescription)", nil)
        return
      }
    }

    // Output path: <caches>/SessionRecording-<timestamp>.mp4
    let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let outputURL = cachesDir.appendingPathComponent("SessionRecording-\(Int(Date().timeIntervalSince1970 * 1000)).mp4")
    if FileManager.default.fileExists(atPath: outputURL.path) {
      try? FileManager.default.removeItem(at: outputURL)
    }

    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
      reject("E_EXPORTER_NIL", "Could not create AVAssetExportSession (passthrough not supported for this asset)", nil)
      return
    }
    exporter.outputURL = outputURL
    exporter.outputFileType = .mp4
    exporter.shouldOptimizeForNetworkUse = false

    exporter.exportAsynchronously {
      switch exporter.status {
      case .completed:
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - started) * 1000.0
        let durationMs = CMTimeGetSeconds(composition.duration) * 1000.0
        resolve([
          "outputUri": outputURL.absoluteString,
          "durationMs": durationMs,
          "spliceMs": elapsedMs,
        ])
      case .failed, .cancelled:
        reject("E_EXPORT_FAILED", exporter.error?.localizedDescription ?? "Export failed with status \(exporter.status.rawValue)", exporter.error)
      default:
        reject("E_EXPORT_UNKNOWN", "Export ended in unexpected state \(exporter.status.rawValue)", nil)
      }
    }
  }

  /// Returns whether a file exists at the given path or file:// URI. Used by
  /// M5's crash-recovery sweep to filter persisted Sessions whose Master file
  /// has gone missing from the caches directory.
  @objc func fileExists(
    _ path: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let url: URL = {
      if path.hasPrefix("file://") {
        return URL(string: path) ?? URL(fileURLWithPath: path)
      }
      return URL(fileURLWithPath: path)
    }()
    resolve(FileManager.default.fileExists(atPath: url.path))
  }

  /// Deletes the file at the given path or file:// URI. Used by the
  /// Library's "Delete Master Recording (keep Session Recording)" action.
  /// Resolves with `true` if a file was removed, `false` if it was already
  /// gone. Rejects only on permission / IO errors.
  @objc func deleteFile(
    _ path: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let url: URL = {
      if path.hasPrefix("file://") {
        return URL(string: path) ?? URL(fileURLWithPath: path)
      }
      return URL(fileURLWithPath: path)
    }()
    if !FileManager.default.fileExists(atPath: url.path) {
      resolve(false)
      return
    }
    do {
      try FileManager.default.removeItem(at: url)
      resolve(true)
    } catch {
      reject("E_DELETE_FAILED", "Could not delete \(url.path): \(error.localizedDescription)", error)
    }
  }
}
