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
import CoreMotion
import React
import UIKit
import UserNotifications

@objc(Splicer)
class Splicer: NSObject {

  /// The export session for the most recent in-flight splice. Held as an
  /// instance var so JS can poll progress via `getSpliceProgress()` —
  /// we only ever run one splice at a time (single user, single Session),
  /// so the lack of an id is fine.
  private var currentExporter: AVAssetExportSession?

  /// CMMotionManager for the IMU-based handheld guardrail (T28 /
  /// decisions-log "Known limitation — handheld false-positive"). The
  /// JS layer polls `getDeviceMotionMagnitude()` to decide whether the
  /// phone is in hand vs on a stand and gates the Segmenter accordingly.
  private let motionManager = CMMotionManager()

  /// Magnitude of the user-induced acceleration (gravity removed),
  /// in g's. Refreshed from `startDeviceMotionUpdates` callbacks at
  /// `deviceMotionUpdateInterval` cadence. Read by JS at a lower rate.
  private var latestUserAccelerationG: Double = 0.0

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
    self.currentExporter = exporter

    exporter.exportAsynchronously {
      // Clear the polled reference before resolving/rejecting so a tail
      // poll from JS sees the cleared state and stops asking.
      self.currentExporter = nil
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

  /// Returns the current splice progress as a Double in 0..1, or 0 if no
  /// splice is in flight. Polled by JS from the Stopping screen to drive
  /// the progress bar — call cadence is ~100ms which is cheap compared
  /// to the per-frame work AVAssetExportSession is doing internally.
  @objc func getSpliceProgress(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let progress = self.currentExporter?.progress ?? 0
    resolve(NSNumber(value: progress))
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

  /// Returns the bytes of free disk space available on the volume the app's
  /// caches directory lives on. Used by the Setup screen's Auto-Record
  /// tap to refuse to start when the disk is too full to hold a
  /// reasonable Master file.
  @objc func getFreeDiskBytes(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    do {
      let values = try cachesDir.resourceValues(forKeys: [.volumeAvailableCapacityForOpportunisticUsageKey])
      if let bytes = values.volumeAvailableCapacityForOpportunisticUsage {
        resolve(NSNumber(value: bytes))
        return
      }
      // Fall through to the older API if the modern key is unavailable.
      let attrs = try FileManager.default.attributesOfFileSystem(forPath: cachesDir.path)
      if let n = attrs[.systemFreeSize] as? NSNumber {
        resolve(n)
        return
      }
      reject("E_DISK_UNKNOWN", "Could not determine free disk bytes", nil)
    } catch {
      reject("E_DISK_FAILED", "getFreeDiskBytes failed: \(error.localizedDescription)", error)
    }
  }

  /// Returns the current thermal pressure as a string: "nominal", "fair",
  /// "serious", or "critical". The Recording screen polls this to surface
  /// a warning badge so the user knows when to plug in / cool down.
  @objc func getThermalState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let state = ProcessInfo.processInfo.thermalState
    let s: String
    switch state {
    case .nominal: s = "nominal"
    case .fair: s = "fair"
    case .serious: s = "serious"
    case .critical: s = "critical"
    @unknown default: s = "nominal"
    }
    resolve(s)
  }

  /// Requests notification permission (alerts only — we never play sound
  /// or badge). Resolves with the granted Bool. Safe to call repeatedly.
  @objc func requestNotificationPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { granted, error in
      if let error = error {
        reject("E_NOTIF_PERM", error.localizedDescription, error)
        return
      }
      resolve(NSNumber(value: granted))
    }
  }

  /// Fires (or schedules a 0-second trigger for) a local notification with
  /// the given title + body. Used by the M6 background-stop path so the
  /// user gets feedback that the OS interruption was handled.
  @objc func scheduleLocalNotification(
    _ title: String,
    body: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger)
    UNUserNotificationCenter.current().add(req) { error in
      if let error = error {
        reject("E_NOTIF_SCHEDULE", error.localizedDescription, error)
      } else {
        resolve(nil)
      }
    }
  }

  /// Sets `UIApplication.shared.isIdleTimerDisabled` so the screen stays
  /// awake while a Session is running (ADR-0002 — the Master encoder
  /// dies when the OS locks the screen; foreground is non-negotiable).
  /// Must be called from the main thread.
  @objc func setIdleTimerDisabled(
    _ disabled: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = disabled.boolValue
      resolve(nil)
    }
  }

  /// Returns the size of the file at the given path or file:// URI in
  /// bytes. Resolves with 0 if the file does not exist — the Dashboard
  /// sums these across all known Sessions so a missing file should
  /// simply not contribute, not throw.
  @objc func getFileSize(
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
      resolve(NSNumber(value: 0))
      return
    }
    do {
      let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
      if let size = attrs[.size] as? NSNumber {
        resolve(size)
      } else {
        resolve(NSNumber(value: 0))
      }
    } catch {
      reject("E_FILE_SIZE", "getFileSize failed: \(error.localizedDescription)", error)
    }
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

  // MARK: - Device motion (handheld guardrail, T28 / ADR-0009)
  //
  // Tracks the user-induced acceleration magnitude (gravity removed)
  // via CMDeviceMotion. JS polls `getDeviceMotionMagnitude` at ~5 Hz
  // and applies hysteresis to decide whether the phone is on a stand
  // (stable, allow Active Segment opens) or in hand (suppress opens
  // to avoid ego-motion false positives).
  //
  // The motion stream itself runs at 10 Hz on a background queue
  // so the main thread is never blocked. `latestUserAccelerationG`
  // is a plain Double — single writer (callback queue), single reader
  // (JS via getDeviceMotionMagnitude), no torn reads on 64-bit
  // architectures.

  /// Begin CMDeviceMotion updates. Idempotent — calling while already
  /// running just resolves true without restarting. Resolves false on
  /// devices that do not have a usable IMU (mostly relevant to the
  /// iPhone Simulator, where motion data is not available).
  @objc func startMotionUpdates(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard motionManager.isDeviceMotionAvailable else {
      resolve(false)
      return
    }
    if motionManager.isDeviceMotionActive {
      resolve(true)
      return
    }
    motionManager.deviceMotionUpdateInterval = 0.1 // 10 Hz
    let queue = OperationQueue()
    queue.qualityOfService = .utility
    motionManager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
      guard let self = self, let motion = motion else { return }
      let ua = motion.userAcceleration
      let mag = sqrt(ua.x * ua.x + ua.y * ua.y + ua.z * ua.z)
      self.latestUserAccelerationG = mag
    }
    resolve(true)
  }

  /// Returns the most recent user-induced acceleration magnitude in
  /// g's. Returns 0 if motion updates haven't been started yet.
  @objc func getDeviceMotionMagnitude(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(latestUserAccelerationG)
  }

  /// Stop the CMDeviceMotion stream. Always safe to call. The stored
  /// magnitude is reset to 0 so a subsequent restart doesn't briefly
  /// surface a stale "moving" reading.
  @objc func stopMotionUpdates(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    if motionManager.isDeviceMotionActive {
      motionManager.stopDeviceMotionUpdates()
    }
    latestUserAccelerationG = 0
    resolve(nil)
  }
}
