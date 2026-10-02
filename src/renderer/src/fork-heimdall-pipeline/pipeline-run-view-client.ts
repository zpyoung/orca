import { translate } from '@/i18n/i18n'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { PipelineEnrollmentPayloadSchema } from '../../../shared/fork-heimdall-pipeline/enrollment-payload'
import {
  BUILTIN_OBJECTIVE_PIPELINE_TEXT,
  BUILTIN_PR_SITTER_PIPELINE_TEXT,
  builtinPipelinePin
} from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import {
  PipelineRunViewSchema,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'

const UNKNOWN_HASH = `sha256:${'0'.repeat(64)}`

function builtinDocument(text: string): PipelineRunView['document'] {
  const parsed = parsePipelineText(text)
  if (parsed.document === null) {
    throw new Error('A built-in pipeline document is invalid')
  }
  return parsed.document
}

function fallbackStatus(row: WatcherFleetEntryReader): PipelineRunView['nodes'][number]['status'] {
  if (row.contact === 'unverifiable' || row.entry.status.state === 'unreachable') {
    return 'unverifiable'
  }
  switch (row.entry.status.state) {
    case 'watching':
    case 'acting':
      return 'running'
    case 'held':
    case 'escalated':
    case 'parked':
      return 'waiting'
    case 'terminal':
      return 'done'
    case 'disabled':
      return 'skipped'
  }
}

function oneNodeView(input: {
  row: WatcherFleetEntryReader
  kind: PipelineRunView['kind']
  id: string
  type: string
  label: string
  ref: string
  scope: PipelineRunView['pin']['scope']
  contentHash: string
  document: PipelineRunView['document']
  runLabel: string
  phase?: string
}): PipelineRunView {
  const { row } = input
  const now = Date.now()
  const startedAtMs = row.entry.status.startedAtMs
  const node = input.document.nodes[0]
  if (!node) {
    throw new Error('A run-view fallback requires a display node')
  }
  return PipelineRunViewSchema.parse({
    watcherId: row.target.watcherId,
    kind: input.kind,
    pin: {
      ref: input.ref,
      scope: input.scope,
      id: input.id,
      contentHash: input.contentHash,
      documentVersion: 1,
      runNumber: null,
      label: input.runLabel
    },
    document: input.document,
    nodes: [
      {
        instanceId: node.id,
        nodeId: node.id,
        type: input.type,
        label: input.label,
        status: fallbackStatus(row),
        waitingFor: null,
        epoch: 0,
        attempt: 0,
        startedAtMs,
        elapsedMs: Math.max(0, now - startedAtMs),
        turns: row.entry.status.budget.turns,
        ...(input.phase === undefined ? {} : { phase: input.phase })
      }
    ],
    edges: [],
    asOfMs: now
  })
}

export function fallbackPipelineRunView(row: WatcherFleetEntryReader): PipelineRunView {
  const kind = row.entry.enrollment.kind
  if (kind === 'objective') {
    const pin = builtinPipelinePin('objective')
    const label = translate('fork.heimdallPipeline.runGraph.objectiveV1', 'Objective v1')
    return oneNodeView({
      row,
      kind,
      id: pin.id,
      type: 'objective',
      label,
      ref: pin.ref,
      scope: pin.scope,
      contentHash: pin.contentHash,
      document: builtinDocument(BUILTIN_OBJECTIVE_PIPELINE_TEXT),
      runLabel: label,
      ...(row.workflowPhase === null || row.workflowPhase === undefined
        ? {}
        : { phase: row.workflowPhase })
    })
  }
  if (kind === 'hosted-review') {
    const pin = builtinPipelinePin('pr-sitter')
    const label = translate('fork.heimdallPipeline.runGraph.prSitterV1', 'PR sitter v1')
    return oneNodeView({
      row,
      kind,
      id: pin.id,
      type: 'pr-sitter',
      label,
      ref: pin.ref,
      scope: pin.scope,
      contentHash: pin.contentHash,
      document: builtinDocument(BUILTIN_PR_SITTER_PIPELINE_TEXT),
      runLabel: label,
      ...(row.workflowPhase === null || row.workflowPhase === undefined
        ? {}
        : { phase: row.workflowPhase })
    })
  }
  if (kind === 'pipeline') {
    const payload = PipelineEnrollmentPayloadSchema.safeParse(row.entry.enrollment.kindPayload)
    if (payload.success) {
      const firstNode = payload.data.document.nodes[0]
      return oneNodeView({
        row,
        kind,
        id: payload.data.pin.id,
        type: firstNode?.type ?? 'unknown',
        label: firstNode?.label ?? payload.data.document.name,
        ref: payload.data.pin.ref,
        scope: payload.data.pin.scope,
        contentHash: payload.data.pin.contentHash,
        document: payload.data.document,
        runLabel: `${payload.data.document.name} v${payload.data.pin.documentVersion}`,
        ...(row.workflowPhase === null || row.workflowPhase === undefined
          ? { phase: row.entry.status.phase }
          : { phase: row.workflowPhase })
      })
    }
  }

  const unknownName = row.entry.enrollment.kind === 'unknown' ? row.entry.name : 'Unknown watcher'
  const document = PipelineRunViewSchema.shape.document.parse({
    version: 1,
    id: 'unknown',
    name: 'Unknown watcher',
    inputs: {},
    nodes: [{ id: 'unknown', type: 'unknown', label: unknownName }]
  })
  return oneNodeView({
    row,
    kind: 'unknown',
    id: 'unknown',
    type: 'unknown',
    label: unknownName,
    ref: 'unknown',
    scope: 'unknown',
    contentHash: UNKNOWN_HASH,
    document,
    runLabel: unknownName
  })
}

/** Reads owner-authoritative ledger projection, falling back for older hosts that lack the method. */
export async function loadPipelineRunView(row: WatcherFleetEntryReader): Promise<PipelineRunView> {
  const api = window.api?.heimdall
  if (typeof api?.pipelineRunView !== 'function') {
    return fallbackPipelineRunView(row)
  }
  try {
    const view = await api.pipelineRunView(row.target)
    return PipelineRunViewSchema.parse(view)
  } catch {
    return fallbackPipelineRunView(row)
  }
}
