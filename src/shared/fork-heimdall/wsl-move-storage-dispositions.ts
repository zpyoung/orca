import {
  notApplicableDisposition,
  type WslMoveFieldDisposition
} from '../wsl-move/wsl-move-dispositions'

const NOT_MOVED = notApplicableDisposition(
  62,
  'Heimdall watcher state; the WSL project mover does not carry or rewrite it.'
)

const tables = (database: string, names: readonly string[]): [string, WslMoveFieldDisposition][] =>
  names.map((name) => [`${database}.${name}`, NOT_MOVED])

export const HEIMDALL_SQLITE_SCHEMA_FILE_DATABASES: Record<string, string> = {
  'src/main/fork-heimdall/database.ts': 'heimdall',
  'src/main/fork-heimdall-objective/objective-database.ts': 'heimdall-objective',
  'src/main/fork-heimdall-pipeline/pipeline-database.ts': 'heimdall-pipeline',
  'src/main/fork-heimdall-pipeline/pipeline-enrollment-table.ts': 'heimdall'
}

export const HEIMDALL_SQLITE_TABLE_DISPOSITIONS: Record<string, WslMoveFieldDisposition> =
  Object.fromEntries([
    ...tables('heimdall', [
      'heimdall_enrollment',
      'heimdall_ledger',
      'heimdall_tick_trace',
      'heimdall_terminal_summary',
      'heimdall_pending_kind_purge',
      'heimdall_pipeline_enrollment',
      'heimdall_pipeline_pending_purge'
    ]),
    ...tables('heimdall-objective', [
      'plan_revision',
      'plan_node',
      'acceptance_criterion',
      'check_attempt',
      'review_verdict',
      'landing_evidence',
      'revision_amendment',
      'objective_dispatch',
      'objective_parallel_state',
      'plan_patch',
      'plan_review',
      'gate_attempt'
    ]),
    ...tables('heimdall-pipeline', [
      'pipeline_run_pin',
      'pipeline_node_output',
      'pipeline_dispatch',
      'pipeline_attempt_baseline',
      'pipeline_swarm_expansion',
      'pipeline_child_worktree',
      'pipeline_merge_progress',
      'pipeline_composite',
      'pipeline_terminal_node_state'
    ])
  ])
