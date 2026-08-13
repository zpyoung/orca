import type Database from '../../sqlite/sync-database'

/**
 * Additive, idempotent DDL for the durable spawn-attempt record (tech.md §5.3). A new table so
 * no existing orchestration table's DDL changes.
 */
export function ensureDispatchSpawnReceiptSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_spawn_receipts (
      dispatch_id         TEXT PRIMARY KEY,       -- dispatch_contexts.id
      spawn_attempt_at    TEXT NOT NULL,          -- written immediately before createTerminal
      spawn_committed_at  TEXT                    -- stamped from onPtySpawnCommitted (shell-level evidence only)
    );
  `)
}
