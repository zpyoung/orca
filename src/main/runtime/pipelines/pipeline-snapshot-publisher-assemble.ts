import type {
  PipelineAttemptRow,
  PipelineNodeRow,
  PipelineRunRow
} from '../orchestration/pipeline-run-db'
import type { ResolvedPipelineDefinition } from '../../../shared/pipeline-template-types'
import {
  derivePipelineNodeStatus,
  type PipelineRunSnapshotWire,
  type PipelineRunState
} from '../../../shared/pipeline-run-snapshot'

/** The narrow read surface the publisher needs from `PipelineRunDb`. */
export type PipelineSnapshotSource = {
  getPipelineRun(runId: string): PipelineRunRow | undefined
  getNodes(runId: string): PipelineNodeRow[]
  getAttempts(runId: string, nodeId?: string): PipelineAttemptRow[]
}

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'aborted',
  'interrupted'
])

export function isTerminalPipelineRunState(state: string): boolean {
  return TERMINAL_RUN_STATES.has(state)
}

export function isLivePipelineRunState(state: string): boolean {
  return state === 'running' || state === 'paused'
}

function runPhaseFor(state: PipelineRunState): 'live' | 'paused' | 'terminal' {
  if (state === 'paused') {
    return 'paused'
  }
  return isTerminalPipelineRunState(state) ? 'terminal' : 'live'
}

function parseLimitMinutesByNodeId(snapshotJson: string): Map<string, number> {
  const limits = new Map<string, number>()
  let definition: ResolvedPipelineDefinition
  try {
    definition = JSON.parse(snapshotJson) as ResolvedPipelineDefinition
  } catch {
    return limits
  }
  for (const node of definition.nodes ?? []) {
    if (typeof node.limits?.maxMinutes === 'number') {
      limits.set(node.id, node.limits.maxMinutes)
    }
  }
  return limits
}

function latestOf(attempts: PipelineAttemptRow[]): PipelineAttemptRow | undefined {
  return attempts.at(-1)
}

function computeLimitBreached(
  attempt: PipelineAttemptRow | undefined,
  limitMinutes: number | undefined,
  now: Date
): boolean {
  if (!attempt || attempt.ended_at !== null || limitMinutes === undefined) {
    return false
  }
  const startedAtMs = Date.parse(attempt.started_at)
  if (Number.isNaN(startedAtMs)) {
    return false
  }
  const elapsedMinutes = (now.getTime() - startedAtMs) / 60_000
  return elapsedMinutes > limitMinutes
}

function groupByNodeId(attempts: PipelineAttemptRow[]): Map<string, PipelineAttemptRow[]> {
  const grouped = new Map<string, PipelineAttemptRow[]>()
  for (const attempt of attempts) {
    const list = grouped.get(attempt.node_id)
    if (list) {
      list.push(attempt)
    } else {
      grouped.set(attempt.node_id, [attempt])
    }
  }
  return grouped
}

/**
 * Assembles a complete pipeline-run snapshot from storage — every field recomputed from
 * current rows, never a delta from a prior push (L23, L24).
 */
export function assemblePipelineSnapshot(
  source: PipelineSnapshotSource,
  runId: string,
  opts: { pausing?: boolean; now?: Date } = {}
): PipelineRunSnapshotWire {
  const now = opts.now ?? new Date()
  const run = source.getPipelineRun(runId)
  if (!run) {
    return { runId, publishedAt: now.toISOString() }
  }

  const phase = runPhaseFor(run.state)
  const limitMinutesByNodeId = parseLimitMinutesByNodeId(run.snapshot_json)
  const attemptsByNodeId = groupByNodeId(source.getAttempts(runId))

  const nodes = source.getNodes(runId).map((nodeRow) => {
    const nodeAttempts = attemptsByNodeId.get(nodeRow.node_id) ?? []
    const latest = latestOf(nodeAttempts)
    const everDispatched = nodeAttempts.length > 0
    const attemptInFlight = latest !== undefined && latest.ended_at === null
    const priorFailedAttempt = nodeAttempts.some((attempt) => attempt.outcome === 'failed')
    const status = derivePipelineNodeStatus({
      terminalOutcome: nodeRow.outcome,
      everDispatched,
      attemptInFlight,
      priorFailedAttempt,
      runPhase: phase
    })
    const limitMinutes = limitMinutesByNodeId.get(nodeRow.node_id)

    return {
      id: nodeRow.node_id,
      title: nodeRow.title,
      status,
      attempt: latest?.attempt,
      attemptsAllowed: 1 + nodeRow.retries_allowed,
      startedAt: latest?.started_at,
      endedAt: latest?.ended_at ?? undefined,
      limitBreached: computeLimitBreached(latest, limitMinutes, now),
      limitMinutes
    }
  })

  return {
    runId,
    templateName: run.template_name,
    runNumber: run.run_number,
    needsNewerOrca: run.needs_newer_orca !== 0,
    state: run.state,
    failureReason: run.failure_reason ?? undefined,
    publishedAt: now.toISOString(),
    pausing: opts.pausing || undefined,
    nodes
  }
}
