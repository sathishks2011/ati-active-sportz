/**
 * Active Segment row CRUD.
 *
 * Segments are appended one at a time as the Segmenter closes them
 * (ADR-0007: "appended on each Segment open/close"). The Segmenter
 * itself only emits close events, so DB rows always represent fully
 * closed (committed) Segments — there's no half-state to recover from.
 *
 * The Splicer wants segments in chronological order; we read with
 * ORDER BY start_seconds for that reason.
 */

import type { ActiveSegmentRecord } from '../state/sessionMachine';
import { getDB } from './db';

export function appendSegment(args: {
  sessionId: number;
  segment: ActiveSegmentRecord;
}) {
  getDB().executeSync(
    `INSERT INTO active_segments
       (session_id, start_seconds, end_seconds, peak_score, created_at_ms)
     VALUES (?, ?, ?, ?, ?);`,
    [
      args.sessionId,
      args.segment.startSeconds,
      args.segment.endSeconds,
      args.segment.peakScore,
      Date.now(),
    ],
  );
}

export function listForSession(sessionId: number): ActiveSegmentRecord[] {
  const result = getDB().executeSync(
    `SELECT start_seconds, end_seconds, peak_score
       FROM active_segments
       WHERE session_id = ?
       ORDER BY start_seconds ASC;`,
    [sessionId],
  );
  return result.rows.map(r => ({
    startSeconds: Number(r.start_seconds),
    endSeconds: Number(r.end_seconds),
    peakScore: Number(r.peak_score),
  }));
}

export function countForSession(sessionId: number): number {
  const result = getDB().executeSync(
    `SELECT COUNT(*) AS n FROM active_segments WHERE session_id = ?;`,
    [sessionId],
  );
  return Number(result.rows[0]?.n ?? 0);
}
