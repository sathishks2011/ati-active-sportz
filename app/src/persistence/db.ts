/**
 * SQLite singleton + schema migrations (M5, ADR-0007).
 *
 * One DB per app install, opened lazily on first call to `getDB()` and
 * kept open for the process lifetime. The schema is small enough that
 * we use simple `CREATE TABLE IF NOT EXISTS` statements gated on a
 * `schema_version` table — when we need a real migration we'll switch to
 * versioned UP scripts.
 *
 * Why op-sqlite specifically (vs RN Async Storage / MMKV / a JSON file):
 *   - ADR-0007 calls for *incremental* metadata writes — each Active
 *     Segment closes mid-Session and must be durable independent of
 *     whatever happens next. A relational store with explicit txns
 *     models that cleanly.
 *   - op-sqlite is JSI/Nitro-backed, consistent with the rest of the
 *     stack (ADR-0008), and the executeSync path is fast enough for
 *     per-segment inserts on the JS thread.
 *
 * State columns intentionally do *not* use the CONTEXT.md SessionState
 * enum (Calibrating / Watching / Capturing / Stopping / Done). The DB
 * doesn't need that sub-state granularity — it only needs to know
 * "still recording", "stopping/splicing", or "finished" so the
 * crash-recovery sweep can find orphans. The coarse mapping is
 * documented on `DbSessionState` below.
 */

import { open, IOS_DOCUMENT_PATH, type DB } from '@op-engineering/op-sqlite';

export type DbSessionState =
  // App is actively recording / detecting. Master file may or may not be
  // flushed to disk yet (VisionCamera flushes at recorder finalization,
  // but the path is reserved as soon as createRecorder runs).
  | 'recording'
  // User tapped Stop; splice is in flight. If the app dies here, the
  // Master is on disk but the Session Recording is not — recovery picks
  // this up and resumes the splice.
  | 'stopping'
  // Splice completed and Session Recording exists. Master may be deleted
  // by the user via the Library; if so, `master_uri` is cleared.
  | 'done';

let _db: DB | null = null;

export function getDB(): DB {
  if (_db != null) return _db;
  _db = open({
    name: 'active-sportz.sqlite',
    location: IOS_DOCUMENT_PATH,
  });
  migrate(_db);
  return _db;
}

function migrate(db: DB) {
  // Pragmas: WAL gives concurrent readers + a writer; foreign_keys ON so
  // cascade deletes do the right thing if we ever need to remove a Session.
  db.executeSync('PRAGMA journal_mode = WAL;');
  db.executeSync('PRAGMA foreign_keys = ON;');

  db.executeSync(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`,
  );
  const versionRow = db.executeSync('SELECT version FROM schema_version;');
  const currentVersion =
    versionRow.rows.length > 0 ? Number(versionRow.rows[0]?.version ?? 0) : 0;

  if (currentVersion < 1) {
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        state TEXT NOT NULL,
        master_uri TEXT,
        session_uri TEXT,
        roi_x REAL NOT NULL,
        roi_y REAL NOT NULL,
        roi_w REAL NOT NULL,
        roi_h REAL NOT NULL,
        used_fixed_threshold INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS active_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        peak_score REAL NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
    db.executeSync(
      `CREATE INDEX IF NOT EXISTS active_segments_session_idx
       ON active_segments(session_id, start_seconds);`,
    );
    if (versionRow.rows.length === 0) {
      db.executeSync('INSERT INTO schema_version (version) VALUES (1);');
    } else {
      db.executeSync('UPDATE schema_version SET version = 1;');
    }
  }
}
