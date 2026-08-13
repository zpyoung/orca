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

type PipelineNodeSnapshotMetadata = { limitMinutes?: number; needs?: string[] }

/** Reads per-node limits and dependency edges from the run's stored `ResolvedPipelineDefinition` — the same record `pipeline-run-db-instantiate.ts` derived task `deps` from at instantiation, so this is that data's one home, not a second copy of it. */
function parseNodeMetadataByNodeId(snapshotJson: string): Map<string, PipelineNodeSnapshotMetadata> {
  const metadata = new Map<string, PipelineNodeSnapshotMetadata>()
  let definition: ResolvedPipelineDefinition
  try {
    definition = JSON.parse(snapshotJson) as ResolvedPipelineDefinition
  } catch {
    return metadata
  }
  for (const node of definition.nodes ?? []) {
    metadata.set(node.id, {
      limitMinutes: typeof node.limits?.maxMinutes === 'number' ? node.limits.maxMinutes : undefined,
      needs: Array.isArray(node.needs) ? node.needs : undefined
    })
  }
  return metadata
}

function latestOf(attempts: PipelineAttemptRow[]): PipelineAttemptRow | undefined {
  return attempts.at(-1)
}

function computeLimitBreached(
  attempt: PipelineAttemptRow | undefined,
  limitMinutes: number | undefined,
  now: Date
): boolean {
  if (!attempt || limitMinutes === undefined) {
    return false
  }
  const startedAtMs = Date.parse(attempt.started_at)
  const endedAtMs = attempt.ended_at === null ? now.getTime() : Date.parse(attempt.ended_at)
  if (Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs)) {
    return false
  }
  const elapsedMinutes = (endedAtMs - startedAtMs) / 60_000
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
 * current rows, never a delta from a prior push.
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
  const nodeMetadataByNodeId = parseNodeMetadataByNodeId(run.snapshot_json)
  const attemptsByNodeId = groupByNodeId(source.getAttempts(runId))

  const nodes = source.getNodes(runId).map((nodeRow) => {
    const nodeAttempts = attemptsByNodeId.get(nodeRow.node_id) ?? []
    const latest = latestOf(nodeAttempts)
    // stage-B prelaunch cycles dispatch a shell but deliberately leave no attempt row
    const everDispatched = nodeAttempts.length > 0 || nodeRow.prelaunch_failures > 0
    const attemptInFlight = latest !== undefined && latest.ended_at === null
    const priorFailedAttempt = nodeAttempts.some((attempt) => attempt.outcome === 'failed')
    const status = derivePipelineNodeStatus({
      terminalOutcome: nodeRow.outcome,
      everDispatched,
      attemptInFlight,
      priorFailedAttempt,
      runPhase: phase
    })
    const metadata = nodeMetadataByNodeId.get(nodeRow.node_id)

    return {
      id: nodeRow.node_id,
      title: nodeRow.title,
      status,
      attempt: latest?.attempt,
      attemptsAllowed: 1 + nodeRow.retries_allowed,
      startedAt: latest?.started_at,
      endedAt: latest?.ended_at ?? undefined,
      limitBreached: computeLimitBreached(latest, metadata?.limitMinutes, now),
      limitMinutes: metadata?.limitMinutes,
      needs: metadata?.needs
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
