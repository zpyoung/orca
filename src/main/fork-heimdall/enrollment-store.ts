import { z } from 'zod'
import { BudgetPolicySchema } from '../../shared/fork-heimdall/budget'
import {
  CapabilityModeSchema,
  WatcherEnrollmentSchema,
  type WatcherEnrollment,
  type WorkspaceKey
} from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallDatabase } from './database'

const EnrollmentRearmConfigurationSchema = z
  .object({
    capabilities: z.record(z.string().min(1), CapabilityModeSchema),
    budget: BudgetPolicySchema,
    kindPayload: z.unknown()
  })
  .strict()

export type EnrollmentRearmConfiguration = z.infer<typeof EnrollmentRearmConfigurationSchema>

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

type EnrollmentRow = {
  watcher_id: string
  kind: string
  workspace_key: string
  execution_host_id: string
  repo_id: string
  worktree_id: string | null
  workspace_path: string
  scheduler_owner: string
  enabled: number
  capabilities_json: string
  budget_json: string
  kind_payload_json: string
  coordinator_handle: string
  coordinator_pane_key: string
  orchestration_run_id: string | null
  created_at_ms: number
  terminal_at_ms: number | null
}

export type EnrollmentStore = {
  get(watcherId: string): EnrollmentRecord | null
  list(): EnrollmentRecord[]
  findLiveByWorkspace(workspaceKey: WorkspaceKey): EnrollmentRecord | null
  insert(enrollment: WatcherEnrollment): WatcherEnrollment
  setEnabled(watcherId: string, enabled: boolean): EnrollmentRecord
  rearm(watcherId: string, configuration: EnrollmentRearmConfiguration): WatcherEnrollment
  setOrchestrationRunId(watcherId: string, runId: string | null): WatcherEnrollment
  markTerminal(watcherId: string, terminalAtMs: number): EnrollmentRecord
}

/** Authoritative, schema-validated enrollment persistence. */
export class HeimdallEnrollmentStore implements EnrollmentStore {
  constructor(private readonly database: HeimdallDatabase) {}

  get(watcherId: string): EnrollmentRecord | null {
    const row = this.database
      .connection()
      .prepare(
        `SELECT watcher_id, kind, workspace_key, execution_host_id, repo_id, worktree_id,
                workspace_path, scheduler_owner, enabled, capabilities_json, budget_json,
                kind_payload_json, coordinator_handle, coordinator_pane_key,
                orchestration_run_id, created_at_ms, terminal_at_ms
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
                workspace_path, scheduler_owner, enabled, capabilities_json, budget_json,
                kind_payload_json, coordinator_handle, coordinator_pane_key,
                orchestration_run_id, created_at_ms, terminal_at_ms
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
                workspace_path, scheduler_owner, enabled, capabilities_json, budget_json,
                kind_payload_json, coordinator_handle, coordinator_pane_key,
                orchestration_run_id, created_at_ms, terminal_at_ms
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
           workspace_path, scheduler_owner, enabled, capabilities_json, budget_json,
           kind_payload_json, coordinator_handle, coordinator_pane_key,
           orchestration_run_id, created_at_ms, terminal_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        this.serializeJson('capabilities', parsed.capabilities),
        this.serializeJson('budget', parsed.budget),
        this.serializeJson('kind payload', parsed.kindPayload),
        parsed.coordinatorIdentity.handle,
        parsed.coordinatorIdentity.paneKey,
        parsed.orchestrationRunId,
        parsed.createdAtMs,
        parsed.terminalAtMs
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

  rearm(watcherId: string, configuration: EnrollmentRearmConfiguration): WatcherEnrollment {
    const parsed = EnrollmentRearmConfigurationSchema.parse(configuration)
    this.updateExisting(
      watcherId,
      `UPDATE heimdall_enrollment
          SET enabled = 1,
              capabilities_json = ?,
              budget_json = ?,
              kind_payload_json = ?
        WHERE watcher_id = ?
          AND terminal_at_ms IS NULL
          AND enabled = 0
          AND json_valid(kind_payload_json)`,
      this.serializeJson('capabilities', parsed.capabilities),
      this.serializeJson('budget', parsed.budget),
      this.serializeJson('kind payload', parsed.kindPayload),
      watcherId
    )
    return this.requireValid(watcherId)
  }

  setOrchestrationRunId(watcherId: string, runId: string | null): WatcherEnrollment {
    const normalizedRunId = runId === null ? null : runId.trim()
    if (normalizedRunId !== null && normalizedRunId.length === 0) {
      throw new Error('An orchestration run id must be non-empty')
    }
    this.requireValid(watcherId)
    this.updateExisting(
      watcherId,
      'UPDATE heimdall_enrollment SET orchestration_run_id = ? WHERE watcher_id = ?',
      normalizedRunId,
      watcherId
    )
    return this.requireValid(watcherId)
  }

  markTerminal(watcherId: string, terminalAtMs: number): EnrollmentRecord {
    if (!Number.isSafeInteger(terminalAtMs) || terminalAtMs < 0) {
      throw new Error('A terminal timestamp must be a non-negative integer')
    }
    this.updateExisting(
      watcherId,
      `UPDATE heimdall_enrollment
          SET enabled = 0, terminal_at_ms = ?
        WHERE watcher_id = ? AND terminal_at_ms IS NULL`,
      terminalAtMs,
      watcherId
    )
    return this.require(watcherId)
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
      capabilities: JSON.parse(row.capabilities_json),
      budget: JSON.parse(row.budget_json),
      kindPayload,
      coordinatorIdentity: {
        handle: row.coordinator_handle,
        paneKey: row.coordinator_pane_key
      },
      orchestrationRunId: row.orchestration_run_id,
      createdAtMs: row.created_at_ms,
      terminalAtMs: row.terminal_at_ms
    })
  }
}
