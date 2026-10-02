import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { PipelineStore } from './pipeline-store'
import { PipelineDatabase } from './pipeline-database'

let root: string
const opened: PipelineDatabase[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-pipeline-database-'))
})

afterEach(() => {
  for (const database of opened) {
    database.close()
  }
  opened.length = 0
  rmSync(root, { recursive: true, force: true })
})

describe('Pipeline database initialization', () => {
  it('initializes the profile-scoped path with all nine tables and its run index', () => {
    const database = new PipelineDatabase(root)
    opened.push(database)
    const connection = database.connection()
    const tableNames = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))

    expect(database.databasePath()).toBe(join(root, 'fork-heimdall-pipeline', 'pipeline.db'))
    expect(tableNames.sort()).toEqual([
      'pipeline_attempt_baseline',
      'pipeline_child_worktree',
      'pipeline_composite',
      'pipeline_dispatch',
      'pipeline_merge_progress',
      'pipeline_node_output',
      'pipeline_run_pin',
      'pipeline_swarm_expansion',
      'pipeline_terminal_node_state'
    ])
    expect(
      connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('pipeline_run_pin_ref_run_number')
    ).toBeDefined()

    database.close()
    const reopened = new PipelineDatabase(root)
    opened.push(reopened)
    expect(
      reopened
        .connection()
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline_%'"
        )
        .get()?.count
    ).toBe(9)
  })

  it('preserves v1 pins and outputs, defaults migrated summaries to null, and reopens summaries', () => {
    const databasePath = join(root, 'fork-heimdall-pipeline', 'pipeline.db')
    mkdirSync(join(root, 'fork-heimdall-pipeline'), { recursive: true })
    const legacy = new Database(databasePath)
    // facts() reads every persisted table, so this must model the complete v1 database.
    legacy.exec(`CREATE TABLE pipeline_run_pin (
      watcher_id TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      scope TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      document_version INTEGER NOT NULL,
      run_number INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL
    );
    CREATE INDEX pipeline_run_pin_ref_run_number ON pipeline_run_pin (ref, run_number);
    CREATE TABLE pipeline_node_output (
      watcher_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      outputs_json TEXT NOT NULL,
      report_sha256 TEXT,
      recorded_at_ms INTEGER NOT NULL,
      PRIMARY KEY (watcher_id, instance_id, epoch, attempt)
    );
    CREATE TABLE pipeline_dispatch (
      watcher_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      dispatch_id TEXT NOT NULL,
      workspace_id TEXT,
      terminal_handle TEXT,
      report_path TEXT NOT NULL,
      dispatched_at_ms INTEGER NOT NULL,
      PRIMARY KEY (watcher_id, instance_id, epoch, attempt)
    );
    CREATE TABLE pipeline_attempt_baseline (
      watcher_id TEXT NOT NULL,
      attempt_fingerprint TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      digest_json TEXT NOT NULL,
      PRIMARY KEY (watcher_id, attempt_fingerprint)
    );
    CREATE TABLE pipeline_swarm_expansion (
      watcher_id TEXT NOT NULL,
      swarm_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      tasks_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      base_commit TEXT,
      PRIMARY KEY (watcher_id, swarm_id, epoch)
    );
    CREATE TABLE pipeline_child_worktree (
      watcher_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      worktree_id TEXT NOT NULL,
      setup_state TEXT NOT NULL,
      PRIMARY KEY (watcher_id, instance_id, epoch)
    );
    CREATE TABLE pipeline_merge_progress (
      watcher_id TEXT NOT NULL,
      merge_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      child_instance_id TEXT NOT NULL,
      state TEXT NOT NULL,
      commit_sha TEXT,
      applied_commit_sha TEXT,
      conflict_json TEXT,
      PRIMARY KEY (watcher_id, merge_id, epoch, child_instance_id)
    );
    CREATE TABLE pipeline_composite (
      watcher_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      kind TEXT NOT NULL,
      kind_payload_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      activated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (watcher_id, instance_id, epoch)
    );`)
    const insertLegacyPin = legacy.prepare(`INSERT INTO pipeline_run_pin (
      watcher_id, ref, scope, pipeline_id, content_hash, document_version, run_number, recorded_at_ms
    ) VALUES (?, 'bugfix', 'repo', 'bugfix', ?, 1, ?, 10)`)
    insertLegacyPin.run('old-watcher-1', `sha256:${'a'.repeat(64)}`, 1)
    insertLegacyPin.run('old-watcher-2', `sha256:${'a'.repeat(64)}`, 2)
    legacy
      .prepare(`INSERT INTO pipeline_node_output (
      watcher_id, instance_id, epoch, attempt, outputs_json, report_sha256, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('old-watcher-2', 'legacy-node', 1, 1, '{"result":"kept"}', null, 11)
    legacy.exec('PRAGMA user_version = 1')
    legacy.close()

    const database = new PipelineDatabase(root)
    opened.push(database)
    const store = new PipelineStore(database)
    expect(store.runPin('old-watcher-2')).toEqual({
      ref: 'bugfix',
      scope: 'repo',
      id: 'bugfix',
      contentHash: `sha256:${'a'.repeat(64)}`,
      documentVersion: 1,
      runNumber: 2
    })
    expect(store.runSource('old-watcher-2')).toBeNull()
    expect(
      database
        .connection()
        .prepare(`SELECT instance_id, epoch, attempt, outputs_json, report_sha256, report_summary
          FROM pipeline_node_output WHERE watcher_id = ?`)
        .get('old-watcher-2')
    ).toEqual({
      instance_id: 'legacy-node',
      epoch: 1,
      attempt: 1,
      outputs_json: '{"result":"kept"}',
      report_sha256: null,
      report_summary: null
    })
    expect(store.facts('old-watcher-2').terminalNodeStates).toBeUndefined()

    const source = { sourceText: 'copied source snapshot' }
    const newPin = {
      ref: 'bugfix',
      scope: 'repo' as const,
      id: 'bugfix-copy',
      contentHash: `sha256:${'b'.repeat(64)}`,
      documentVersion: 1 as const
    }
    expect(store.recordRunPin('new-watcher', newPin, 20, source)).toEqual({ runNumber: 3 })
    store.recordNodeOutput({
      watcherId: 'new-watcher',
      instanceId: 'summary-node',
      epoch: 2,
      attempt: 3,
      outputs: { result: 'kept separate' },
      reportSha256: null,
      reportSummary: 'Validated report summary',
      nowMs: 21
    })
    store.recordTerminalNodeStates('new-watcher', [
      {
        instanceId: 'summary-node',
        status: 'done',
        epoch: 2,
        attempt: 3,
        startedAtMs: 30,
        elapsedMs: 70,
        turns: 4
      },
      { instanceId: 'skipped-node', status: 'skipped', epoch: 1, attempt: 0, turns: 0 }
    ])
    database.close()

    const reopened = new PipelineDatabase(root)
    opened.push(reopened)
    const reopenedStore = new PipelineStore(reopened)
    expect(reopenedStore.runPin('old-watcher-1')).toMatchObject({ runNumber: 1 })
    expect(reopenedStore.runPin('old-watcher-2')).toMatchObject({ runNumber: 2 })
    expect(reopenedStore.runPin('new-watcher')).toEqual({ ...newPin, runNumber: 3 })
    expect(reopenedStore.runSource('new-watcher')).toEqual(source)
    const savedOutput = reopened
      .connection()
      .prepare('SELECT outputs_json, report_summary FROM pipeline_node_output WHERE watcher_id = ?')
      .get('new-watcher')
    expect(JSON.parse(String(savedOutput?.outputs_json))).toEqual({ result: 'kept separate' })
    expect(savedOutput?.report_summary).toBe('Validated report summary')
    expect(
      reopened
        .connection()
        .prepare('SELECT report_summary FROM pipeline_node_output WHERE watcher_id = ?')
        .get('old-watcher-2')
    ).toEqual({ report_summary: null })
    expect(reopenedStore.facts('new-watcher').terminalNodeStates).toEqual([
      {
        instanceId: 'summary-node',
        status: 'done',
        epoch: 2,
        attempt: 3,
        startedAtMs: 30,
        elapsedMs: 70,
        turns: 4
      },
      { instanceId: 'skipped-node', status: 'skipped', epoch: 1, attempt: 0, turns: 0 }
    ])
  })
})
