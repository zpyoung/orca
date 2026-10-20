import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  WatcherEnrollmentSchema,
  type WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import type { FiredStopPredicate } from '../../shared/fork-heimdall/stop-policy'
import { HeimdallDatabase } from '../fork-heimdall/database'
import { KernelTerminalTransition } from '../fork-heimdall/kernel-terminal-transition'
import { drainPendingKindPurges } from '../fork-heimdall/pending-kind-purge'
import { HeimdallEnrollmentStore } from '../fork-heimdall/enrollment-store'
import { HeimdallLedgerStore } from '../fork-heimdall/ledger-store'
import { WatcherKindRegistry, type RegisteredWatcherKind } from '../fork-heimdall/registry'
import {
  PipelineAwareEnrollmentStore,
  isDuplicateWorkspaceError
} from './pipeline-aware-enrollment-store'
import { PIPELINE_ENROLLMENT_TABLES } from './pipeline-enrollment-table'

let root: string
let database: HeimdallDatabase
let enrollments: PipelineAwareEnrollmentStore

function enrollment(overrides: Partial<WatcherEnrollment> = {}): WatcherEnrollment {
  return {
    watcherId: 'pipeline-1',
    kind: 'pipeline',
    workspaceKey: 'local::/pipeline-workspace',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/pipeline-workspace',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { merge: 'gated' },
    budget: { wallClockActiveMs: 60_000, turns: 2 },
    kindPayload: { pin: 'test' },
    coordinatorIdentity: { handle: 'heimdall-1', paneKey: 'heimdall-pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    ...overrides
  }
}

function unusedKind(
  id: RegisteredWatcherKind['id'],
  purge?: (watcherId: string) => void
): RegisteredWatcherKind {
  return {
    id,
    displayName: id,
    enrollmentPayloadSchema: z.unknown(),
    describeEnrollment: () => id,
    authorizeEnrollment: async () => {
      throw new Error('unused test kind')
    },
    read: async () => {
      throw new Error('unused test kind')
    },
    describeSnapshot: () => {
      throw new Error('unused test kind')
    },
    decide: () => {
      throw new Error('unused test kind')
    },
    execute: async () => {
      throw new Error('unused test kind')
    },
    resolveOutcome: () => {
      throw new Error('unused test kind')
    },
    ...(purge ? { purge } : {})
  }
}

type LegacyEnrollmentSqlRow = {
  watcherId: string
  kind: string
  workspaceKey: string
  executionHostId: string
  repoId: string
  worktreeId: string | null
  workspacePath: string
  schedulerOwner: string
  enabled: number
  paused: number
  commandRevision: number
  capabilitiesJson: string
  budgetJson: string
  kindPayloadJson: string
  coordinatorHandle: string
  coordinatorPaneKey: string
  orchestrationRunId: string | null
  createdAtMs: number
  terminalAtMs: number | null
  ownerJson: string | null
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-heimdall-pipeline-enrollment-'))
  database = new HeimdallDatabase(root)
  enrollments = new PipelineAwareEnrollmentStore(database)
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('pipeline-aware enrollment persistence', () => {
  it('routes kinds to their own tables and preserves built-in parser compatibility', () => {
    const pipeline = enrollment({ watcherId: 'pipeline-row', createdAtMs: 1 })
    const objective = enrollment({
      watcherId: 'objective-row',
      kind: 'objective',
      workspaceKey: 'local::/objective-workspace',
      createdAtMs: 1
    })
    enrollments.insert(pipeline)
    enrollments.insert(objective)

    expect(
      database.connection().prepare('SELECT COUNT(*) AS count FROM heimdall_enrollment').get()
    ).toEqual({ count: 1 })
    expect(
      database
        .connection()
        .prepare('SELECT COUNT(*) AS count FROM heimdall_pipeline_enrollment')
        .get()
    ).toEqual({ count: 1 })
    expect(enrollments.get(pipeline.watcherId)).toEqual(pipeline)
    expect(enrollments.get(objective.watcherId)).toEqual(objective)
    expect(enrollments.list()).toEqual([objective, pipeline])

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every selected alias and SQLite primitive matches this v4-era row projection.
    const legacyRows = database
      .connection()
      .prepare(
        `SELECT watcher_id AS watcherId, kind, workspace_key AS workspaceKey,
                execution_host_id AS executionHostId, repo_id AS repoId, worktree_id AS worktreeId,
                workspace_path AS workspacePath, scheduler_owner AS schedulerOwner,
                enabled, paused, command_revision AS commandRevision,
                capabilities_json AS capabilitiesJson, budget_json AS budgetJson,
                kind_payload_json AS kindPayloadJson, coordinator_handle AS coordinatorHandle,
                coordinator_pane_key AS coordinatorPaneKey,
                orchestration_run_id AS orchestrationRunId, created_at_ms AS createdAtMs,
                terminal_at_ms AS terminalAtMs, owner_json AS ownerJson
           FROM heimdall_enrollment`
      )
      .all() as LegacyEnrollmentSqlRow[]
    expect(
      legacyRows.map((row) =>
        WatcherEnrollmentSchema.parse({
          watcherId: row.watcherId,
          kind: row.kind,
          workspaceKey: row.workspaceKey,
          executionHostId: row.executionHostId,
          repoId: row.repoId,
          worktreeId: row.worktreeId,
          workspacePath: row.workspacePath,
          schedulerOwner: row.schedulerOwner,
          enabled: row.enabled === 1,
          paused: row.paused === 1,
          commandRevision: row.commandRevision,
          capabilities: JSON.parse(row.capabilitiesJson),
          budget: JSON.parse(row.budgetJson),
          kindPayload: JSON.parse(row.kindPayloadJson),
          coordinatorIdentity: {
            handle: row.coordinatorHandle,
            paneKey: row.coordinatorPaneKey
          },
          owner: row.ownerJson ? JSON.parse(row.ownerJson) : undefined,
          orchestrationRunId: row.orchestrationRunId,
          createdAtMs: row.createdAtMs,
          terminalAtMs: row.terminalAtMs
        })
      )
    ).toEqual([objective])
  })

  it('rolls back only an unchanged insertion and refuses a row advanced after insertion', () => {
    const inserted = enrollments.insert(enrollment({ watcherId: 'rollback-insert' }))

    expect(enrollments.rollbackInserted(inserted)).toEqual({ status: 'rolled-back' })
    expect(enrollments.get(inserted.watcherId)).toBeNull()

    const advanced = enrollments.insert(enrollment({ watcherId: 'advanced-insert' }))
    enrollments.setEnabled(advanced.watcherId, false)
    enrollments.rearm(advanced.watcherId, {
      capabilities: advanced.capabilities,
      budget: advanced.budget,
      kindPayload: advanced.kindPayload
    })

    expect(enrollments.rollbackInserted(advanced)).toMatchObject({
      status: 'refused',
      reason: 'row-changed'
    })
    expect(enrollments.get(advanced.watcherId)).toMatchObject({
      enabled: true,
      commandRevision: advanced.commandRevision + 1
    })
  })

  it('refuses duplicate live workspaces across tables in either insertion order', () => {
    const builtinFirst = enrollment({
      watcherId: 'builtin-first',
      kind: 'objective',
      workspaceKey: 'local::/shared-one'
    })
    enrollments.insert(builtinFirst)
    let pipelineRefusal: unknown
    try {
      enrollments.insert(
        enrollment({ watcherId: 'pipeline-second', workspaceKey: 'local::/shared-one' })
      )
    } catch (error) {
      pipelineRefusal = error
    }
    expect(isDuplicateWorkspaceError(pipelineRefusal)).toBe(true)
    expect(
      pipelineRefusal instanceof Error ? pipelineRefusal.message : String(pipelineRefusal)
    ).toContain('heimdall_enrollment.workspace_key')
    expect(enrollments.get('pipeline-second')).toBeNull()

    const pipelineFirst = enrollment({
      watcherId: 'pipeline-first',
      workspaceKey: 'local::/shared-two'
    })
    enrollments.insert(pipelineFirst)
    let builtinRefusal: unknown
    try {
      enrollments.insert(
        enrollment({
          watcherId: 'builtin-second',
          kind: 'objective',
          workspaceKey: 'local::/shared-two'
        })
      )
    } catch (error) {
      builtinRefusal = error
    }
    expect(isDuplicateWorkspaceError(builtinRefusal)).toBe(true)
    expect(
      builtinRefusal instanceof Error ? builtinRefusal.message : String(builtinRefusal)
    ).toContain('heimdall_pipeline_enrollment.workspace_key')
    expect(enrollments.get('builtin-second')).toBeNull()
    enrollments.markTerminal(pipelineFirst.watcherId, 10)
    expect(
      enrollments.insert(
        enrollment({
          watcherId: 'builtin-after-terminal',
          kind: 'objective',
          workspaceKey: 'local::/shared-two'
        })
      )
    ).toMatchObject({ watcherId: 'builtin-after-terminal' })
  })

  it('rolls back pipeline ledger and enrollment writes when a transaction callback fails', () => {
    const created = enrollments.insert(enrollment())
    const ledger = new HeimdallLedgerStore(database)
    expect(() =>
      enrollments.markTerminal(created.watcherId, 20, () => {
        ledger.append({
          eventId: 'pipeline-rollback-evidence',
          watcherId: created.watcherId,
          atMs: 10,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'budget-generation',
          payload: { reason: 're-enrollment-after-explicit-disarm' }
        })
        throw new Error('append failed')
      })
    ).toThrow('append failed')
    expect(enrollments.get(created.watcherId)?.terminalAtMs).toBeNull()
    expect(ledger.read(created.watcherId).entries).toEqual([])
  })

  it('compacts retention for a dismissed pipeline enrollment', () => {
    const created = enrollments.insert(enrollment())
    const ledger = new HeimdallLedgerStore(database)
    ledger.append({
      kind: 'terminal',
      eventId: 'pipeline-terminal',
      watcherId: created.watcherId,
      atMs: 20,
      origin: 'owner',
      class: 'fact',
      state: 'merged',
      reason: 'completed'
    })
    enrollments.markTerminal(created.watcherId, 20)

    expect(
      ledger.compactTerminal(created.watcherId, 'pipeline', {
        activeMs: 0,
        turns: 0,
        exhausted: null
      })
    ).toMatchObject({ watcherId: created.watcherId, terminalState: 'merged' })
  })

  it('writes pipeline deletions to the side purge table and drains them once', async () => {
    const created = enrollments.insert(enrollment({ watcherId: 'deleted-pipeline' }))
    expect(
      enrollments.deleteWatcher(created.watcherId, {
        executionHostId: created.executionHostId,
        schedulerOwner: created.schedulerOwner,
        workspaceKey: created.workspaceKey,
        revision: created.commandRevision
      })
    ).toEqual({ status: 'deleted' })
    expect(enrollments.get(created.watcherId)).toBeNull()
    expect(
      database
        .connection()
        .prepare('SELECT COUNT(*) AS count FROM heimdall_pending_kind_purge')
        .get()
    ).toEqual({ count: 0 })
    expect(
      database.connection().prepare('SELECT watcher_id FROM heimdall_pipeline_pending_purge').all()
    ).toEqual([{ watcher_id: created.watcherId }])

    const purgedWatcherIds: string[] = []
    const registry = new WatcherKindRegistry()
    registry.register(
      unusedKind('pipeline', (watcherId) => {
        purgedWatcherIds.push(watcherId)
      })
    )

    await drainPendingKindPurges(enrollments, registry)
    expect(purgedWatcherIds).toEqual([created.watcherId])
    expect(enrollments.pendingKindPurges()).toEqual([])
  })

  it('recognizes pipeline-table workspace conflicts in terminal handoff retries', () => {
    const claimedWorkspaceKey = 'local::/claimed-by-pipeline'
    const source = enrollments.insert(
      enrollment({
        watcherId: 'handoff-source',
        kind: 'objective',
        workspaceKey: 'local::/handoff-source'
      })
    )
    enrollments.insert(
      enrollment({
        watcherId: 'pipeline-claim',
        workspaceKey: claimedWorkspaceKey
      })
    )
    const ledger = new HeimdallLedgerStore(database)
    let nextEvent = 0
    const transition = new KernelTerminalTransition({
      enrollments,
      ledger,
      now: () => 50,
      createId: () => {
        nextEvent += 1
        return `transition-event-${nextEvent}`
      },
      authorize: async () => {
        throw new Error('not called')
      },
      mintCoordinatorIdentity: (seed) => ({ handle: seed, paneKey: seed }),
      readLedger: (watcherId) => ledger.read(watcherId)
    })
    const fired: FiredStopPredicate = {
      predicateId: 'handoff-completed',
      disposition: 'terminal',
      reason: 'handoff completed'
    }

    const result = transition.commit(source, fired, {
      status: 'enroll',
      kind: unusedKind('objective'),
      enrollment: enrollment({
        watcherId: 'handoff-target',
        kind: 'objective',
        workspaceKey: claimedWorkspaceKey,
        kindPayload: { reviewUrl: 'https://example.test/review/1' }
      })
    })
    const sourceEntries = ledger.read(source.watcherId).entries

    expect(result.handoff).toEqual({ status: 'refused', detail: 'duplicate-workspace' })
    expect(enrollments.get(source.watcherId)?.terminalAtMs).toBe(50)
    expect(sourceEntries.find((entry) => entry.kind === 'terminal')).toMatchObject({
      state: 'handoff-completed',
      reason: 'handoff completed'
    })
    expect(
      sourceEntries.find((entry) => entry.kind === 'evidence' && entry.evidenceKind === 'handoff')
    ).toBeUndefined()
    expect(enrollments.findLiveByWorkspace(claimedWorkspaceKey)?.watcherId).toBe('pipeline-claim')
    expect(enrollments.get('handoff-target')).toBeNull()
  })

  it('reports live pipeline rows claimed by built-in rows during downgrade overlap', () => {
    const builtin = new HeimdallEnrollmentStore(database)
    const pipeline = new HeimdallEnrollmentStore(database, PIPELINE_ENROLLMENT_TABLES)
    const workspaceKey = 'local::/overlap'
    builtin.insert(enrollment({ watcherId: 'builtin-overlap', kind: 'objective', workspaceKey }))
    pipeline.insert(enrollment({ watcherId: 'pipeline-overlap', workspaceKey }))

    expect(enrollments.pipelineRowsClaimedByBuiltin()).toEqual([
      { pipelineWatcherId: 'pipeline-overlap', builtinWatcherId: 'builtin-overlap' }
    ])
  })
})

describe('read-only database from a newer build without pipeline tables', () => {
  it('serves built-in enrollments instead of failing on the missing pipeline tables', () => {
    const objective = enrollment({
      watcherId: 'objective-row',
      kind: 'objective',
      workspaceKey: 'local::/objective-workspace'
    })
    enrollments.insert(objective)
    // simulates a newer schema written by a build that never created the pipeline side tables
    database.connection().exec(`
      DROP TABLE heimdall_pipeline_enrollment;
      DROP TABLE heimdall_pipeline_pending_purge;
      PRAGMA user_version = 99;
    `)
    database.close()

    database = new HeimdallDatabase(root)
    enrollments = new PipelineAwareEnrollmentStore(database)

    expect(database.isReadOnly()).toBe(true)
    expect(enrollments.list()).toEqual([objective])
    expect(enrollments.get(objective.watcherId)).toEqual(objective)
    expect(enrollments.get('pipeline-1')).toBeNull()
    expect(enrollments.findLiveByWorkspace(objective.workspaceKey)).toEqual(objective)
    expect(enrollments.findLiveByWorkspace('local::/pipeline-workspace')).toBeNull()
    expect(enrollments.pendingKindPurges()).toEqual([])
    expect(enrollments.pipelineRowsClaimedByBuiltin()).toEqual([])
  })
})
