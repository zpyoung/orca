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
    needs?: string[]
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

type PipelineRunSnapshotWireNode = NonNullable<PipelineRunSnapshotWire['nodes']>[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function assignIfPresent<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value
  }
}

function decodePipelineSnapshotNode(raw: unknown): PipelineRunSnapshotWireNode | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') {
    return null
  }
  const node: PipelineRunSnapshotWireNode = { id: raw.id }
  assignIfPresent(node, 'title', readOptionalString(raw, 'title'))
  assignIfPresent(node, 'status', readOptionalString(raw, 'status'))
  assignIfPresent(node, 'attempt', readOptionalNumber(raw, 'attempt'))
  assignIfPresent(node, 'attemptsAllowed', readOptionalNumber(raw, 'attemptsAllowed'))
  assignIfPresent(node, 'startedAt', readOptionalString(raw, 'startedAt'))
  assignIfPresent(node, 'endedAt', readOptionalString(raw, 'endedAt'))
  assignIfPresent(node, 'limitBreached', readOptionalBoolean(raw, 'limitBreached'))
  assignIfPresent(node, 'limitMinutes', readOptionalNumber(raw, 'limitMinutes'))
  if (Array.isArray(raw.needs) && raw.needs.every((id) => typeof id === 'string')) {
    node.needs = raw.needs as string[]
  }
  return node
}

/**
 * Structural admission for a `pipeline.subscribe` payload from either transport: rejects
 * outright only when `runId` itself isn't a string, and otherwise drops (never forwards)
 * any field or node whose shape doesn't match — the wire's non-identifying fields are
 * optional by design (host version skew), so a malformed one must degrade, not throw.
 */
export function decodePipelineRunSnapshotWire(raw: unknown): PipelineRunSnapshotWire | null {
  if (!isRecord(raw) || typeof raw.runId !== 'string') {
    return null
  }
  const snapshot: PipelineRunSnapshotWire = { runId: raw.runId }
  assignIfPresent(snapshot, 'templateName', readOptionalString(raw, 'templateName'))
  assignIfPresent(snapshot, 'runNumber', readOptionalNumber(raw, 'runNumber'))
  assignIfPresent(snapshot, 'needsNewerOrca', readOptionalBoolean(raw, 'needsNewerOrca'))
  assignIfPresent(snapshot, 'state', readOptionalString(raw, 'state'))
  assignIfPresent(snapshot, 'failureReason', readOptionalString(raw, 'failureReason'))
  assignIfPresent(snapshot, 'publishedAt', readOptionalString(raw, 'publishedAt'))
  assignIfPresent(snapshot, 'pausing', readOptionalBoolean(raw, 'pausing'))
  if (Array.isArray(raw.nodes)) {
    snapshot.nodes = raw.nodes
      .map((node) => decodePipelineSnapshotNode(node))
      .filter((node): node is PipelineRunSnapshotWireNode => node !== null)
  }
  return snapshot
}
