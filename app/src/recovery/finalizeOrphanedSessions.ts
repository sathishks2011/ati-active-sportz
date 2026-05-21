/**
 * Crash-recovery sweep (M5, ADR-0007).
 *
 * On every launch, scan for `sessions` rows whose `state != 'done'`. For
 * each such row:
 *   - If the Master file is still on disk and at least one Active
 *     Segment was committed before the crash, splice with whatever
 *     segments exist, save the Session Recording to Photos, and mark
 *     the row `done`. Per ADR-0007 / decisions-log this is *silent* —
 *     no recovery prompt; the entry just appears in the Library.
 *   - If the Master is missing (file gone, or never created — the row
 *     was opened but the recorder crashed before `attachMasterUri`),
 *     mark `done` with no `session_uri`. The row stays in the Library
 *     so the user can see "this Session was started but produced no
 *     recording" rather than having it vanish silently.
 *   - If the Master exists but no Segments were closed before the
 *     crash, same as above — there is no content to splice. (Without
 *     segments we won't produce a Session Recording; the Master is
 *     still on disk and deletable via the Library.)
 *
 * Runs in the background on App mount. The UI can show a brief
 * "Restoring previous Sessions…" panel while the promise is in flight;
 * if no orphans exist it returns quickly and the panel never appears.
 */

import {
  CameraRoll,
  iosRequestAddOnlyGalleryPermission,
} from '@react-native-camera-roll/camera-roll';
import { fileExists, splice } from '../native/Splicer';
import { findUnfinished, markDone } from '../persistence/sessionRepo';
import { listForSession } from '../persistence/segmentRepo';

export type RecoveryResult = {
  inspected: number;
  finalized: number;
  abandoned: number;
};

export async function finalizeOrphanedSessions(): Promise<RecoveryResult> {
  const orphans = findUnfinished();
  const result: RecoveryResult = {
    inspected: orphans.length,
    finalized: 0,
    abandoned: 0,
  };
  if (orphans.length === 0) return result;
  console.log('[recovery] inspecting', orphans.length, 'orphan session(s)');

  for (const row of orphans) {
    try {
      const hasMaster =
        row.masterUri != null && (await fileExists(row.masterUri));
      const segments = listForSession(row.id);

      if (!hasMaster || segments.length === 0) {
        console.log('[recovery] abandoning session', row.id, {
          hasMaster,
          segmentCount: segments.length,
        });
        markDone({
          sessionId: row.id,
          sessionUri: '',
          endedAtMs: Date.now(),
        });
        // If the Master is on disk but unusable (no segments), keep it
        // — the user can spot-check via the Library and delete by hand.
        result.abandoned++;
        continue;
      }

      console.log('[recovery] finalizing session', row.id, {
        segmentCount: segments.length,
      });
      const spliceResult = await splice(
        row.masterUri!,
        segments.map(s => ({
          startSeconds: s.startSeconds,
          endSeconds: s.endSeconds,
        })),
      );
      // Best-effort Photos save. If the user has revoked permission,
      // we still mark `done` with the Session Recording URI — they can
      // copy it later out of the sandbox.
      try {
        const perm = await iosRequestAddOnlyGalleryPermission();
        if (perm === 'granted' || perm === 'limited') {
          await CameraRoll.saveAsset(spliceResult.outputUri, {
            type: 'video',
          }).catch(() =>
            CameraRoll.saveAsset(
              spliceResult.outputUri.replace(/^file:\/\//, ''),
              { type: 'video' },
            ),
          );
        }
      } catch (e: any) {
        console.warn('[recovery] Photos save failed', e?.message ?? e);
      }

      markDone({
        sessionId: row.id,
        sessionUri: spliceResult.outputUri,
        endedAtMs: Date.now(),
      });
      result.finalized++;
    } catch (e: any) {
      console.warn(
        '[recovery] failed to finalize session',
        row.id,
        e?.message ?? e,
      );
      // Leave the row in its current state — next launch will retry.
      // The user is not surfaced to the failure; they just won't see
      // that Session in the Library yet. Investigating this requires
      // dev tooling we'll add in M7.
    }
  }

  return result;
}

