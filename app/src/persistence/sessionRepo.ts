/**
 * Session row CRUD. All calls are synchronous via op-sqlite's
 * `executeSync` — the queries are tiny (single-row reads/writes) and
 * the alternative (await on every state transition) added bridge calls
 * for no perceptible latency win. M7 can revisit if profiling shows
 * a per-segment write stall.
 */

import type { Roi } from '../state/sessionMachine';
import type { DbSessionState } from './db';
import { getDB } from './db';

export type SessionRow = {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
  state: DbSessionState;
  masterUri: string | null;
  sessionUri: string | null;
  roi: Roi;
  usedFixedThreshold: boolean;
};

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: Number(r.id),
    startedAtMs: Number(r.started_at_ms),
    endedAtMs: r.ended_at_ms == null ? null : Number(r.ended_at_ms),
    state: String(r.state) as DbSessionState,
    masterUri: (r.master_uri as string | null) ?? null,
    sessionUri: (r.session_uri as string | null) ?? null,
    roi: {
      x: Number(r.roi_x),
      y: Number(r.roi_y),
      w: Number(r.roi_w),
      h: Number(r.roi_h),
    },
    usedFixedThreshold: Number(r.used_fixed_threshold) === 1,
  };
}

export function openSession(args: { startedAtMs: number; roi: Roi }): number {
  const result = getDB().executeSync(
    `INSERT INTO sessions
      (started_at_ms, state, roi_x, roi_y, roi_w, roi_h)
     VALUES (?, 'recording', ?, ?, ?, ?);`,
    [
      args.startedAtMs,
      args.roi.x,
      args.roi.y,
      args.roi.w,
      args.roi.h,
    ],
  );
  if (result.insertId == null) {
    throw new Error('openSession: missing insertId');
  }
  return result.insertId;
}

export function attachMasterUri(sessionId: number, masterUri: string) {
  getDB().executeSync(
    `UPDATE sessions SET master_uri = ? WHERE id = ?;`,
    [masterUri, sessionId],
  );
}

export function markStopping(sessionId: number) {
  getDB().executeSync(
    `UPDATE sessions SET state = 'stopping' WHERE id = ?;`,
    [sessionId],
  );
}

export function markFixedThreshold(sessionId: number) {
  getDB().executeSync(
    `UPDATE sessions SET used_fixed_threshold = 1 WHERE id = ?;`,
    [sessionId],
  );
}

export function markDone(args: {
  sessionId: number;
  sessionUri: string;
  endedAtMs: number;
}) {
  getDB().executeSync(
    `UPDATE sessions
       SET state = 'done', session_uri = ?, ended_at_ms = ?
       WHERE id = ?;`,
    [args.sessionUri, args.endedAtMs, args.sessionId],
  );
}

/**
 * Sessions that did not reach `done` — used by the crash-recovery sweep
 * to find what to finalize on next launch.
 */
export function findUnfinished(): SessionRow[] {
  const result = getDB().executeSync(
    `SELECT * FROM sessions
       WHERE state != 'done'
       ORDER BY started_at_ms ASC;`,
  );
  return result.rows.map(r => rowToSession(r as Record<string, unknown>));
}

export function listDone(): SessionRow[] {
  const result = getDB().executeSync(
    `SELECT * FROM sessions
       WHERE state = 'done'
       ORDER BY started_at_ms DESC;`,
  );
  return result.rows.map(r => rowToSession(r as Record<string, unknown>));
}

/**
 * "Delete Master Recording (keep Session Recording)" Library action.
 * Clears the path in DB; the caller is responsible for the file-system
 * delete via the native splicer (we don't want this repo to import
 * native modules).
 */
export function clearMasterUri(sessionId: number) {
  getDB().executeSync(
    `UPDATE sessions SET master_uri = NULL WHERE id = ?;`,
    [sessionId],
  );
}

export function getSession(sessionId: number): SessionRow | null {
  const result = getDB().executeSync(
    `SELECT * FROM sessions WHERE id = ?;`,
    [sessionId],
  );
  if (result.rows.length === 0) return null;
  return rowToSession(result.rows[0] as Record<string, unknown>);
}

// ─── Dashboard aggregates ───────────────────────────────────────────────────
// These are read from the Dashboard's "stats" cards. Kept synchronous —
// each query is a single aggregate over small tables, so even with
// hundreds of Sessions the latency is sub-millisecond.

export function countDone(): number {
  const result = getDB().executeSync(
    `SELECT COUNT(*) AS n FROM sessions WHERE state = 'done';`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export function mostRecentDone(): SessionRow | null {
  const result = getDB().executeSync(
    `SELECT * FROM sessions
       WHERE state = 'done'
       ORDER BY started_at_ms DESC
       LIMIT 1;`,
  );
  if (result.rows.length === 0) return null;
  return rowToSession(result.rows[0] as Record<string, unknown>);
}

/**
 * Sum of Active Segment durations across all `done` Sessions, in seconds.
 * Surfaces as "active gameplay captured" on the Dashboard — the
 * cumulative time the detector found play happening, *not* the total
 * Session wall-clock.
 */
export function sumActiveSeconds(): number {
  const result = getDB().executeSync(
    `SELECT COALESCE(SUM(a.end_seconds - a.start_seconds), 0) AS s
       FROM active_segments a
       JOIN sessions sn ON sn.id = a.session_id
       WHERE sn.state = 'done';`,
  );
  return Number(result.rows[0]?.s ?? 0);
}
