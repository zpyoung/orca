import type { PipelineRunNodeView } from '../../../shared/fork-heimdall-pipeline/run-view-types'

export type PipelineNodeVisualState =
  | 'failed'
  | 'needs-you'
  | 'running'
  | 'waiting'
  | 'pending'
  | 'done'
  | 'skipped'
  | 'unknown'

export type PipelineRunEdgeState = 'idle' | 'active' | 'done' | 'skipped'

/** Collapses a run node's status and waitingFor into the one visual state its card shows; total and never throws. */
export function pipelineNodeVisualState(
  node: Pick<PipelineRunNodeView, 'status' | 'waitingFor'>
): PipelineNodeVisualState {
  const { status, waitingFor } = node
  if (status === 'failed') {
    return 'failed'
  }
  const terminal = status === 'done' || status === 'skipped'
  if (
    !terminal &&
    (waitingFor === 'gate' || waitingFor === 'choice' || waitingFor === 'capability-approval')
  ) {
    return 'needs-you'
  }
  if (status === 'running') {
    return 'running'
  }
  if (status === 'waiting' || (!terminal && waitingFor === 'owner')) {
    return 'waiting'
  }
  if (status === 'pending' || status === 'done' || status === 'skipped') {
    return status
  }
  return 'unknown'
}

/** Derives how an edge looks from the visual states of the two nodes it joins. */
export function pipelineRunEdgeState(
  source: PipelineNodeVisualState,
  target: PipelineNodeVisualState
): PipelineRunEdgeState {
  if (target === 'skipped') {
    return 'skipped'
  }
  if (source === 'done') {
    return target === 'running' || target === 'needs-you' ? 'active' : 'done'
  }
  return 'idle'
}
