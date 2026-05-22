/**
 * Session row CRUD. All calls are synchronous via op-sqlite's
 * `executeSync` — the queries are tiny (single-row reads/writes) and
 * the alternative (await on every state transition) added bridge calls
 * for no perceptible latency win. M7 can revisit if profiling shows
 * a per-segment write stall.
 */

import type { Roi, RoiCorner } from '../state/sessionMachine';
import type { DbSessionState } from './db';
import { getDB } from './db';

// Internal identifier for the per-Session Detection Mode (ADR-0009).
// UI labels (`Smart` / `Enhanced` / `Continuous`) live behind
// `labelForMode` in the screens layer — the DB and store always speak
// in these identifiers.
//   - 'motion'     — motion-only detection (UI: "Smart")
//   - 'players'    — motion + on-device player detection (UI: "Enhanced")
//   - 'continuous' — no detection; the Master Recording is saved
//                    directly as the user-facing video, no Active
//                    Segments, no splice. Useful for non-court captures
//                    and for validating the recording path in isolation
//                    (UI: "Continuous").
export type DetectionMode = 'motion' | 'players' | 'continuous';

export type SessionRow = {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
  state: DbSessionState;
  masterUri: string | null;
  sessionUri: string | null;
  roi: Roi;
  setupZoom: number;
  detectionMode: DetectionMode;
  usedFixedThreshold: boolean;
};

function parseCorners(json: unknown): Roi['corners'] {
  // Defensive parse — a malformed row should not crash the Library list.
  // If we can't deserialize, return a unit-square quad so the row remains
  // visible but the ROI is obviously wrong.
  if (typeof json !== 'string') {
    return [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every(
        c =>
          Array.isArray(c) &&
          c.length === 2 &&
          typeof c[0] === 'number' &&
          typeof c[1] === 'number',
      )
    ) {
      return [
        parsed[0] as RoiCorner,
        parsed[1] as RoiCorner,
        parsed[2] as RoiCorner,
        parsed[3] as RoiCorner,
      ] as const;
    }
  } catch {
    // fall through to the unit-square fallback
  }
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const;
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  const rawMode = String(r.detection_mode ?? 'motion');
  const detectionMode: DetectionMode =
    rawMode === 'players'
      ? 'players'
      : rawMode === 'continuous'
        ? 'continuous'
        : 'motion';
  return {
    id: Number(r.id),
    startedAtMs: Number(r.started_at_ms),
    endedAtMs: r.ended_at_ms == null ? null : Number(r.ended_at_ms),
    state: String(r.state) as DbSessionState,
    masterUri: (r.master_uri as string | null) ?? null,
    sessionUri: (r.session_uri as string | null) ?? null,
    roi: { corners: parseCorners(r.roi_corners) },
    setupZoom: Number(r.setup_zoom ?? 1),
    detectionMode,
    usedFixedThreshold: Number(r.used_fixed_threshold) === 1,
  };
}

export function openSession(args: {
  startedAtMs: number;
  // Null when Mode is 'continuous' — no Court ROI is captured. The DB
  // column is nullable; rowToSession() returns a unit-square fallback
  // so consumers don't have to special-case the read path.
  roi: Roi | null;
  setupZoom: number;
  detectionMode: DetectionMode;
}): number {
  const cornersJson =
    args.roi == null ? null : JSON.stringify(args.roi.corners);
  const result = getDB().executeSync(
    `INSERT INTO sessions
      (started_at_ms, state, roi_corners, setup_zoom, detection_mode)
     VALUES (?, 'recording', ?, ?, ?);`,
    [args.startedAtMs, cornersJson, args.setupZoom, args.detectionMode],
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
 * Recovered-finish marker. Used when the recorder errored or the splice
 * failed but the Master file is on disk — we move the row to 'done' so
 * the in-app Library can surface it, but leave `session_uri` NULL so the
 * Library knows there's no spliced output and can render a "Master
 * preserved" entry instead of a normal Session Recording.
 */
export function markDoneRecovered(args: {
  sessionId: number;
  endedAtMs: number;
}) {
  getDB().executeSync(
    `UPDATE sessions
       SET state = 'done', ended_at_ms = ?
       WHERE id = ?;`,
    [args.endedAtMs, args.sessionId],
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
