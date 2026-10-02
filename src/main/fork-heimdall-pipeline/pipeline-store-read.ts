import type Database from '../sqlite/sync-database'
import type { SqliteStatement } from '../sqlite/sync-database'
import {
  PipelineTerminalNodeStatesSchema,
  type PipelineStoreFacts
} from '../../shared/fork-heimdall-pipeline/store-facts'

type PipelineComposite = PipelineStoreFacts['composites'][number]
type PipelineMergeProgress = PipelineStoreFacts['mergeProgress'][number]
type PipelineSwarmExpansion = PipelineStoreFacts['swarmExpansions'][number]

type NodeOutputRow = {
  instance_id: string
  epoch: number
  attempt: number
  outputs_json: string
  report_sha256: string | null
  report_summary: string | null
}

type DispatchRow = {
  instance_id: string
  epoch: number
  attempt: number
  dispatch_id: string
  workspace_id: string | null
  terminal_handle: string | null
  report_path: string
  dispatched_at_ms: number
}

type SwarmExpansionRow = {
  swarm_id: string
  epoch: number
  tasks_json: string
  warnings_json: string
  base_commit: string | null
}
type ChildWorktreeRow = {
  instance_id: string
  epoch: number
  worktree_id: string
  setup_state: string
}
type MergeProgressRow = {
  merge_id: string
  epoch: number
  child_instance_id: string
  state: string
  commit_sha: string | null
  applied_commit_sha: string | null
  conflict_json: string | null
}

export type PipelineCompositeRow = {
  instance_id: string
  epoch: number
  kind: string
  kind_payload_json: string
  capabilities_json: string
  activated_at_ms: number
}
type TerminalNodeStatesRow = { node_states_json: string }

export function pipelineStoreRows<T>(
  statement: SqliteStatement,
  ...params: readonly Database.BindValue[]
): T[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite types each row as Record<string, SQLOutputValue>; call sites match T to their selected columns.
  return statement.all(...params) as T[]
}

export function parsePipelineStoreJson<T>(serialized: string, field: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error(`Pipeline database contains malformed ${field} JSON`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this column is only written from the matching typed store argument.
  return parsed as T
}

export function readPipelineFacts(
  db: Database.Database,
  watcherId: string,
  pin: PipelineStoreFacts['pin']
): PipelineStoreFacts {
  const outputs = pipelineStoreRows<NodeOutputRow>(
    db.prepare(`SELECT instance_id, epoch, attempt,
      outputs_json, report_sha256, report_summary FROM pipeline_node_output WHERE watcher_id = ?
      ORDER BY instance_id, epoch, attempt`),
    watcherId
  )
  const dispatches = pipelineStoreRows<DispatchRow>(
    db.prepare(`SELECT instance_id, epoch, attempt,
      dispatch_id, workspace_id, terminal_handle, report_path, dispatched_at_ms
      FROM pipeline_dispatch WHERE watcher_id = ? ORDER BY instance_id, epoch, attempt`),
    watcherId
  )
  const swarmExpansions = pipelineStoreRows<SwarmExpansionRow>(
    db.prepare(`SELECT swarm_id, epoch,
      tasks_json, warnings_json, base_commit FROM pipeline_swarm_expansion WHERE watcher_id = ?
      ORDER BY swarm_id, epoch`),
    watcherId
  )
  const childWorktrees = pipelineStoreRows<ChildWorktreeRow>(
    db.prepare(`SELECT instance_id, epoch,
      worktree_id, setup_state FROM pipeline_child_worktree WHERE watcher_id = ?
      ORDER BY instance_id, epoch`),
    watcherId
  )
  const mergeProgress = pipelineStoreRows<MergeProgressRow>(
    db.prepare(`SELECT merge_id, epoch,
      child_instance_id, state, commit_sha, applied_commit_sha, conflict_json
      FROM pipeline_merge_progress WHERE watcher_id = ? ORDER BY merge_id, epoch, child_instance_id`),
    watcherId
  )
  const composites = pipelineStoreRows<PipelineCompositeRow>(
    db.prepare(`SELECT instance_id, epoch, kind,
      kind_payload_json, capabilities_json, activated_at_ms FROM pipeline_composite
      WHERE watcher_id = ? ORDER BY instance_id, epoch`),
    watcherId
  )
  const terminalNodeStatesRow = pipelineStoreRows<TerminalNodeStatesRow>(
    db.prepare(`SELECT node_states_json FROM pipeline_terminal_node_state WHERE watcher_id = ?`),
    watcherId
  )[0]
  const terminalNodeStates =
    terminalNodeStatesRow === undefined
      ? undefined
      : PipelineTerminalNodeStatesSchema.parse(
          parsePipelineStoreJson(terminalNodeStatesRow.node_states_json, 'terminal node states')
        )

  return {
    pin,
    outputs: outputs.map((row) => ({
      instanceId: row.instance_id,
      epoch: row.epoch,
      attempt: row.attempt,
      outputs: parsePipelineStoreJson<Record<string, unknown>>(row.outputs_json, 'node outputs'),
      reportSha256: row.report_sha256,
      reportSummary: row.report_summary
    })),
    dispatches: dispatches.map((row) => ({
      instanceId: row.instance_id,
      epoch: row.epoch,
      attempt: row.attempt,
      dispatchId: row.dispatch_id,
      workspaceId: row.workspace_id,
      terminalHandle: row.terminal_handle,
      reportPath: row.report_path,
      dispatchedAtMs: row.dispatched_at_ms
    })),
    swarmExpansions: swarmExpansions.map((row) => ({
      swarmId: row.swarm_id,
      epoch: row.epoch,
      tasks: parsePipelineStoreJson<PipelineSwarmExpansion['tasks']>(row.tasks_json, 'Swarm tasks'),
      warnings: parsePipelineStoreJson<PipelineSwarmExpansion['warnings']>(
        row.warnings_json,
        'Swarm warnings'
      ),
      baseCommit: row.base_commit
    })),
    childWorktrees: childWorktrees.map((row) => ({
      instanceId: row.instance_id,
      epoch: row.epoch,
      worktreeId: row.worktree_id,
      setupState: row.setup_state
    })),
    mergeProgress: mergeProgress.map((row) => {
      if (
        row.state !== 'pending' &&
        row.state !== 'applied' &&
        row.state !== 'conflict' &&
        row.state !== 'resolving' &&
        row.state !== 'resolved' &&
        row.state !== 'skipped'
      ) {
        throw new Error('Pipeline database contains an invalid merge state')
      }
      return {
        mergeId: row.merge_id,
        epoch: row.epoch,
        childInstanceId: row.child_instance_id,
        state: row.state,
        commitSha: row.commit_sha,
        appliedCommitSha: row.applied_commit_sha,
        conflict:
          row.conflict_json === null
            ? null
            : parsePipelineStoreJson<PipelineMergeProgress['conflict']>(
                row.conflict_json,
                'merge conflict'
              )
      }
    }),
    composites: composites.map((row) => {
      if (row.kind !== 'hosted-review') {
        throw new Error('Pipeline database contains an invalid composite kind')
      }
      return {
        kindPayload: parsePipelineStoreJson(row.kind_payload_json, 'composite kind payload'),
        instanceId: row.instance_id,
        epoch: row.epoch,
        kind: row.kind,
        capabilities: parsePipelineStoreJson<PipelineComposite['capabilities']>(
          row.capabilities_json,
          'composite capabilities'
        ),
        activatedAtMs: row.activated_at_ms
      }
    }),
    ...(terminalNodeStates === undefined ? {} : { terminalNodeStates })
  }
}
