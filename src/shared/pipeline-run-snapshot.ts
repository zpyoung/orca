export type PipelineNodeStatus =
  | 'waiting'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'not_run'
  | 'held'
  | 'interrupted'

export type PipelineRunState =
  | 'setup'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'interrupted'

export type PipelineNodeObservables = {
  terminalOutcome: 'succeeded' | 'failed' | null
  everDispatched: boolean
  attemptInFlight: boolean
  priorFailedAttempt: boolean
  runPhase: 'live' | 'paused' | 'terminal'
}

export type PipelineRunSnapshotWire = {
  runId: string
  templateName?: string
  runNumber?: number
  needsNewerOrca?: boolean
  state?: string
  failureReason?: string
  publishedAt?: string
  pausing?: boolean
  nodes?: {
    id: string
    title?: string
    status?: string
    attempt?: number
    attemptsAllowed?: number
    startedAt?: string
    endedAt?: string
    limitBreached?: boolean
    limitMinutes?: number
  }[]
}

const NODE_STATUS_VALUES: readonly PipelineNodeStatus[] = [
  'waiting',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'not_run',
  'held',
  'interrupted'
]

const RUN_STATE_VALUES: readonly PipelineRunState[] = [
  'setup',
  'running',
  'paused',
  'completed',
  'failed',
  'aborted',
  'interrupted'
]

/**
 * C6 binding precedence over the five observables (T, E, F, H, R). Computed host-side at
 * snapshot assembly; the client only decodes via `decodePipelineNodeStatus`.
 */
export function derivePipelineNodeStatus(o: PipelineNodeObservables): PipelineNodeStatus {
  if (o.terminalOutcome === 'succeeded') {
    return 'succeeded'
  }
  if (o.terminalOutcome === 'failed') {
    return 'failed'
  }

  if (o.runPhase === 'terminal') {
    return o.everDispatched ? 'interrupted' : 'not_run'
  }

  if (o.everDispatched) {
    return o.priorFailedAttempt ? 'retrying' : 'running'
  }

  return o.runPhase === 'paused' ? 'held' : 'waiting'
}

/** Unknown-tolerant decode (L25, AC18): never throws, falls back to `'unknown'`. */
export function decodePipelineNodeStatus(tag: string | undefined): PipelineNodeStatus | 'unknown' {
  return (NODE_STATUS_VALUES as readonly string[]).includes(tag as string)
    ? (tag as PipelineNodeStatus)
    : 'unknown'
}

/** Unknown-tolerant decode (L25, AC18): never throws, falls back to `'unknown'`. */
export function decodePipelineRunState(tag: string | undefined): PipelineRunState | 'unknown' {
  return (RUN_STATE_VALUES as readonly string[]).includes(tag as string)
    ? (tag as PipelineRunState)
    : 'unknown'
}
