import { z } from 'zod'
import { BudgetPolicySchema } from '../../shared/fork-heimdall/budget'
import type { WatcherOwnerFence } from '../../shared/fork-heimdall/fleet-types'
import { WatcherOwnerConfigSchema } from '../../shared/fork-heimdall/owner/owner-config'
import {
  CapabilityModeSchema,
  WatcherEnrollmentSchema,
  type WatcherEnrollment,
  type WorkspaceKey
} from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallDatabase } from './database'
import {
  completePendingKindPurge,
  deleteWatcherEnrollment,
  readPendingKindPurges,
  type EnrollmentDeleteCommit,
  type PendingKindPurge
} from './enrollment-deletion'
import type { EnrollmentRow } from './enrollment-row'
import { withImmediateTransaction } from './transaction-scope'

const EnrollmentRearmConfigurationSchema = z
  .object({
    capabilities: z.record(z.string().min(1), CapabilityModeSchema),
    budget: BudgetPolicySchema,
    kindPayload: z.unknown(),
    owner: WatcherOwnerConfigSchema.optional()
  })
  .strict()

export type EnrollmentRearmConfiguration = z.infer<typeof EnrollmentRearmConfigurationSchema>

const EnrollmentControlChangeSchema = z
  .object({
    enabled: z.boolean().optional(),
    paused: z.boolean().optional(),
    budget: BudgetPolicySchema.optional(),
    kindPayload: z.unknown().optional()
  })
  .strict()

export type EnrollmentControlChange = z.infer<typeof EnrollmentControlChangeSchema>
export type EnrollmentControlCommit =
  | { status: 'committed'; enrollment: EnrollmentRecord }
  | {
      status: 'refused'
      reason: 'watcher-not-found' | 'owner-conflict' | 'stale-revision' | 'invalid-state'
      detail: string
    }

export type MalformedKindPayloadEnrollment = Omit<WatcherEnrollment, 'kindPayload'> & {
  malformedKindPayload: {
    rawJson: string
    reason: string
  }
}

export type EnrollmentRecord = WatcherEnrollment | MalformedKindPayloadEnrollment

export function isMalformedKindPayloadEnrollment(
  enrollment: EnrollmentRecord
): enrollment is MalformedKindPayloadEnrollment {
  return 'malformedKindPayload' in enrollment
}

export type EnrollmentStore = {
  get(watcherId: string): EnrollmentRecord | null
  list(): EnrollmentRecord[]
  findLiveByWorkspace(workspaceKey: WorkspaceKey): EnrollmentRecord | null
  insert(enrollment: WatcherEnrollment): WatcherEnrollment
  commitControl(
    watcherId: string,
    expectedOwner: WatcherOwnerFence,
    change: EnrollmentControlChange,
    appendWithinTransaction?: () => void
  ): EnrollmentControlCommit
  deleteWatcher(watcherId: string, expectedOwner: WatcherOwnerFence): EnrollmentDeleteCommit
  pendingKindPurges(): PendingKindPurge[]
  completeKindPurge(watcherId: string): void
  setEnabled(watcherId: string, enabled: boolean): EnrollmentRecord
  rearm(
    watcherId: string,
    configuration: EnrollmentRearmConfiguration,
    appendWithinTransaction?: () => void
  ): WatcherEnrollment
  setOrchestrationRunId(watcherId: string, runId: string | null): WatcherEnrollment
  markTerminal(
    watcherId: string,
    terminalAtMs: number,
    appendWithinTransaction?: () => void,
    afterTerminalWithinTransaction?: () => void
  ): EnrollmentRecord
}

/** Authoritative, schema-validated enrollment persistence. */
export class HeimdallEnrollmentStore implements EnrollmentStore {
  constructor(private readonly database: HeimdallDatabase) {}

  get(watcherId: string): EnrollmentRecord | null {
    const row = this.database
      .connection()
      .prepare(
        `SELECT watcher_id, kind, workspace_key, execution_host_id, repo_id, worktree_id,
                workspace_path, scheduler_owner, enabled, paused, command_revision,
                capabilities_json, budget_json, kind_payload_json, coordinator_handle,
                coordinator_pane_key, orchestration_run_id, created_at_ms, terminal_at_ms,
                owner_json
           FROM heimdall_enrollment
          WHERE watcher_id = ?`
      )
      .get(watcherId) as EnrollmentRow | undefined
    return row ? this.parseRecord(row) : null
  }

  list(): EnrollmentRecord[] {
    const rows = this.database
      .connection()
      .prepare(
        `SELECT watcher_id, kind, workspace_key, execution_host_id, repo_id, worktree_id,
                workspace_path, scheduler_owner, enabled, paused, command_revision,
                capabilities_json, budget_json, kind_payload_json, coordinator_handle,
                coordinator_pane_key, orchestration_run_id, created_at_ms, terminal_at_ms,
                owner_json
           FROM heimdall_enrollment
          ORDER BY created_at_ms, watcher_id`
      )
      .all() as EnrollmentRow[]
    return rows.map((row) => this.parseRecord(row))
  }

  findLiveByWorkspace(workspaceKey: WorkspaceKey): EnrollmentRecord | null {
    const row = this.database
      .connection()
      .prepare(
        `SELECT watcher_id, kind, workspace_key, execution_host_id, repo_id, worktree_id,
                workspace_path, scheduler_owner, enabled, paused, command_revision,
                capabilities_json, budget_json, kind_payload_json, coordinator_handle,
                coordinator_pane_key, orchestration_run_id, created_at_ms, terminal_at_ms,
                owner_json
           FROM heimdall_enrollment
          WHERE workspace_key = ? AND terminal_at_ms IS NULL`
      )
      .get(workspaceKey) as EnrollmentRow | undefined
    return row ? this.parseRecord(row) : null
  }

  insert(enrollment: WatcherEnrollment): WatcherEnrollment {
    const parsed = WatcherEnrollmentSchema.parse(enrollment)
    this.database.assertWritable()
    this.database
      .connection()
      .prepare(
        `INSERT INTO heimdall_enrollment (
           watcher_id, kind, workspace_key, execution_host_id, repo_id, worktree_id,
           workspace_path, scheduler_owner, enabled, paused, command_revision, capabilities_json,
           budget_json, kind_payload_json, coordinator_handle, coordinator_pane_key,
           orchestration_run_id, created_at_ms, terminal_at_ms, owner_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parsed.watcherId,
        parsed.kind,
        parsed.workspaceKey,
        parsed.executionHostId,
        parsed.repoId,
        parsed.worktreeId,
        parsed.workspacePath,
        parsed.schedulerOwner,
        parsed.enabled ? 1 : 0,
        parsed.paused ? 1 : 0,
        parsed.commandRevision,
        this.serializeJson('capabilities', parsed.capabilities),
        this.serializeJson('budget', parsed.budget),
        this.serializeJson('kind payload', parsed.kindPayload),
        parsed.coordinatorIdentity.handle,
        parsed.coordinatorIdentity.paneKey,
        parsed.orchestrationRunId,
        parsed.createdAtMs,
        parsed.terminalAtMs,
        this.serializeOwner(parsed.owner)
      )
    return parsed
  }

  setEnabled(watcherId: string, enabled: boolean): EnrollmentRecord {
    this.updateExisting(
      watcherId,
      `UPDATE heimdall_enrollment
          SET enabled = ?
        WHERE watcher_id = ? AND terminal_at_ms IS NULL`,
      enabled ? 1 : 0,
      watcherId
    )
    return this.require(watcherId)
  }

  rearm(
    watcherId: string,
    configuration: EnrollmentRearmConfiguration,
    appendWithinTransaction?: () => void
  ): WatcherEnrollment {
    if (!watcherId) {
      throw new Error('A watcher id is required')
    }
    const parsed = EnrollmentRearmConfigurationSchema.parse(configuration)
    const capabilities = this.serializeJson('capabilities', parsed.capabilities)
    const budget = this.serializeJson('budget', parsed.budget)
    const kindPayload = this.serializeJson('kind payload', parsed.kindPayload)
    const owner = this.serializeOwner(parsed.owner)
    this.database.assertWritable()
    const connection = this.database.connection()
    return withImmediateTransaction(connection, () => {
      const result = connection
        .prepare(
          `UPDATE heimdall_enrollment
              SET enabled = 1,
                  paused = 0,
                  command_revision = command_revision + 1,
                  capabilities_json = ?,
                  budget_json = ?,
                  kind_payload_json = ?,
                  owner_json = ?
            WHERE watcher_id = ?
              AND terminal_at_ms IS NULL
              AND enabled = 0
              AND json_valid(kind_payload_json)`
        )
        .run(capabilities, budget, kindPayload, owner, watcherId)
      if (Number(result.changes) !== 1) {
        throw new Error(`Unknown or immutable Heimdall watcher: ${watcherId}`)
      }
      appendWithinTransaction?.()
      return this.requireValid(watcherId)
    })
  }

  commitControl(
    watcherId: string,
    expectedOwner: WatcherOwnerFence,
    untrustedChange: EnrollmentControlChange,
    appendWithinTransaction?: () => void
  ): EnrollmentControlCommit {
    if (!watcherId) {
      return { status: 'refused', reason: 'watcher-not-found', detail: 'A watcher id is required' }
    }
    const change = EnrollmentControlChangeSchema.parse(untrustedChange)
    this.database.assertWritable()
    const connection = this.database.connection()
    connection.exec('BEGIN IMMEDIATE')
    try {
      const current = this.get(watcherId)
      if (!current) {
        connection.exec('ROLLBACK')
        return {
          status: 'refused',
          reason: 'watcher-not-found',
          detail: `Heimdall watcher ${watcherId} was not found`
        }
      }
      if (
        current.executionHostId !== expectedOwner.executionHostId ||
        current.schedulerOwner !== expectedOwner.schedulerOwner ||
        current.workspaceKey !== expectedOwner.workspaceKey
      ) {
        connection.exec('ROLLBACK')
        return {
          status: 'refused',
          reason: 'owner-conflict',
          detail: `Heimdall watcher ${watcherId} is owned by a different execution authority`
        }
      }
      if (current.commandRevision !== expectedOwner.revision) {
        connection.exec('ROLLBACK')
        return {
          status: 'refused',
          reason: 'stale-revision',
          detail: `Heimdall watcher ${watcherId} advanced to revision ${current.commandRevision}`
        }
      }
      if (current.terminalAtMs !== null) {
        connection.exec('ROLLBACK')
        return {
          status: 'refused',
          reason: 'invalid-state',
          detail: `Heimdall watcher ${watcherId} is terminal`
        }
      }
      const kindPayload = Object.hasOwn(change, 'kindPayload')
        ? change.kindPayload
        : 'kindPayload' in current
          ? current.kindPayload
          : null

      const result = connection
        .prepare(
          `UPDATE heimdall_enrollment
              SET enabled = ?,
                  paused = ?,
                  budget_json = ?,
                  kind_payload_json = ?,
                  command_revision = command_revision + 1
            WHERE watcher_id = ? AND command_revision = ? AND terminal_at_ms IS NULL`
        )
        .run(
          (change.enabled ?? current.enabled) ? 1 : 0,
          (change.paused ?? current.paused) ? 1 : 0,
          this.serializeJson('budget', change.budget ?? current.budget),
          this.serializeJson('kind payload', kindPayload),
          watcherId,
          expectedOwner.revision
        )
      if (Number(result.changes) !== 1) {
        throw new Error(`Heimdall watcher ${watcherId} changed during its control transaction`)
      }
      appendWithinTransaction?.()
      const enrollment = this.require(watcherId)
      connection.exec('COMMIT')
      return { status: 'committed', enrollment }
    } catch (error) {
      if (connection.isTransaction) {
        connection.exec('ROLLBACK')
      }
      throw error
    }
  }
  deleteWatcher(watcherId: string, expectedOwner: WatcherOwnerFence): EnrollmentDeleteCommit {
    return deleteWatcherEnrollment({
      database: this.database,
      watcherId,
      expectedOwner,
      read: () => this.get(watcherId)
    })
  }

  pendingKindPurges(): PendingKindPurge[] {
    return readPendingKindPurges(this.database)
  }

  completeKindPurge(watcherId: string): void {
    completePendingKindPurge(this.database, watcherId)
  }

  setOrchestrationRunId(watcherId: string, runId: string | null): WatcherEnrollment {
    const normalizedRunId = runId === null ? null : runId.trim()
    if (normalizedRunId !== null && normalizedRunId.length === 0) {
      throw new Error('An orchestration run id must be non-empty')
    }
    this.requireValid(watcherId)
    this.updateExisting(
      watcherId,
      'UPDATE heimdall_enrollment SET orchestration_run_id = ? WHERE watcher_id = ? AND terminal_at_ms IS NULL',
      normalizedRunId,
      watcherId
    )
    return this.requireValid(watcherId)
  }

  markTerminal(
    watcherId: string,
    terminalAtMs: number,
    appendWithinTransaction?: () => void,
    afterTerminalWithinTransaction?: () => void
  ): EnrollmentRecord {
    if (!Number.isSafeInteger(terminalAtMs) || terminalAtMs < 0) {
      throw new Error('A terminal timestamp must be a non-negative integer')
    }
    this.database.assertWritable()
    const connection = this.database.connection()
    return withImmediateTransaction(connection, () => {
      const current = this.require(watcherId)
      if (current.terminalAtMs !== null) {
        return current
      }
      appendWithinTransaction?.()
      const result = connection
        .prepare(
          `UPDATE heimdall_enrollment
              SET enabled = 0, paused = 0, terminal_at_ms = ?
            WHERE watcher_id = ? AND terminal_at_ms IS NULL`
        )
        .run(terminalAtMs, watcherId)
      if (Number(result.changes) !== 1) {
        throw new Error(`Heimdall watcher ${watcherId} changed during its terminal transaction`)
      }
      afterTerminalWithinTransaction?.()
      return this.require(watcherId)
    })
  }

  private require(watcherId: string): EnrollmentRecord {
    const enrollment = this.get(watcherId)
    if (!enrollment) {
      throw new Error(`Unknown Heimdall watcher: ${watcherId}`)
    }
    return enrollment
  }

  private requireValid(watcherId: string): WatcherEnrollment {
    const enrollment = this.require(watcherId)
    if (isMalformedKindPayloadEnrollment(enrollment)) {
      throw new Error(`Heimdall watcher ${watcherId} kind payload is malformed`)
    }
    return enrollment
  }

  private updateExisting(
    watcherId: string,
    sql: string,
    ...values: (string | number | null)[]
  ): void {
    if (!watcherId) {
      throw new Error('A watcher id is required')
    }
    this.database.assertWritable()
    const result = this.database
      .connection()
      .prepare(sql)
      .run(...values)
    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown or immutable Heimdall watcher: ${watcherId}`)
    }
  }

  private serializeJson(label: string, value: unknown): string {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new Error(`Heimdall enrollment ${label} is not JSON-serializable`)
    }
    return serialized
  }

  private serializeOwner(owner: WatcherEnrollment['owner']): string | null {
    return owner ? JSON.stringify(owner) : null
  }

  private parseRecord(row: EnrollmentRow): EnrollmentRecord {
    let kindPayload: unknown
    try {
      kindPayload = JSON.parse(row.kind_payload_json)
    } catch (error) {
      const parsed = this.parseRow(row, null)
      const { kindPayload: _kindPayload, ...enrollment } = parsed
      return {
        ...enrollment,
        malformedKindPayload: {
          rawJson: row.kind_payload_json,
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    }
    return this.parseRow(row, kindPayload)
  }

  private parseRow(row: EnrollmentRow, kindPayload: unknown): WatcherEnrollment {
    return WatcherEnrollmentSchema.parse({
      watcherId: row.watcher_id,
      kind: row.kind,
      workspaceKey: row.workspace_key,
      executionHostId: row.execution_host_id,
      repoId: row.repo_id,
      worktreeId: row.worktree_id,
      workspacePath: row.workspace_path,
      schedulerOwner: row.scheduler_owner,
      enabled: row.enabled === 1,
      paused: row.paused === 1,
      commandRevision: row.command_revision,
      capabilities: JSON.parse(row.capabilities_json),
      budget: JSON.parse(row.budget_json),
      kindPayload,
      coordinatorIdentity: {
        handle: row.coordinator_handle,
        paneKey: row.coordinator_pane_key
      },
      owner: row.owner_json ? JSON.parse(row.owner_json) : undefined,
      orchestrationRunId: row.orchestration_run_id,
      createdAtMs: row.created_at_ms,
      terminalAtMs: row.terminal_at_ms
    })
  }
}
