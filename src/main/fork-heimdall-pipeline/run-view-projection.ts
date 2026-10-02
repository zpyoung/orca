import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import type { WatcherWorker, WatcherWorkerNavigation } from '../../shared/fork-heimdall/fleet-types'
import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveDetail } from '../../shared/fork-heimdall-objective/detail-types'
import {
  BUILTIN_OBJECTIVE_PIPELINE_TEXT,
  BUILTIN_PR_SITTER_PIPELINE_TEXT,
  builtinPipelinePin
} from '../../shared/fork-heimdall-pipeline/builtin-pipelines'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import {
  objectiveCompositePhase,
  sitterCompositePhase
} from '../../shared/fork-heimdall-pipeline/composite-phase'
import { builtinOneNodeRunState } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineDocument } from '../../shared/fork-heimdall-pipeline/document-schema'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import {
  PipelineSourceSnapshotSchema,
  type PipelineSourceSnapshot
} from '../../shared/fork-heimdall-pipeline/pipeline-source'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import { routeEnrollmentKind } from '../../shared/fork-heimdall-pipeline/enrollment-routing'
import { validatePipeline } from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import {
  PipelineRunViewSchema,
  type PipelineRunNodeView,
  type PipelineRunView
} from '../../shared/fork-heimdall-pipeline/run-view-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  pipelinePlanReviewInFlight,
  pipelineWorkerNavigationIndex
} from './run-view-projection-facts'
import { projectPipelineRunNodes } from './run-view-projection-pipeline-nodes'

type PipelineRunEdge = { from: string; to: string; when?: string }
type LegacyPipelineKind = 'objective' | 'hosted-review'
type PinnedRun = {
  pin: PipelinePin & { runNumber: number | null }
  document: PipelineDocument
}

function builtinDocument(text: string): PipelineDocument {
  const parsed = parsePipelineText(text)
  if (parsed.document === null) {
    throw new Error('A built-in pipeline document is invalid')
  }
  return parsed.document
}

function objectiveProgress(detail: ObjectiveDetail | undefined): {
  progress?: { done: number; total: number }
  revision?: number
} {
  const revision = detail?.revisions.find((candidate) => candidate.status === 'approved')
  if (!detail || !revision) {
    return {}
  }
  const nodes = detail.nodes.filter((node) => node.revisionId === revision.id)
  return {
    progress: {
      done: nodes.filter((node) => node.state === 'succeeded' || node.state === 'replanned').length,
      total: nodes.length
    },
    revision: revision.number
  }
}

function objectiveChecks(
  contract: ObjectiveEnrollmentPayload,
  detail: ObjectiveDetail | undefined
): { name: string; result: unknown }[] {
  return (contract.gates ?? []).map((gate) => ({
    name: gate.name,
    result: detail?.gates?.find((candidate) => candidate.name === gate.name)?.lastResult ?? null
  }))
}

function builtinNodeView(input: {
  kind: LegacyPipelineKind
  document: PipelineDocument
  displayLabel: string
  phase: string
  ledger: WatcherLedger
  progress?: { done: number; total: number }
  revision?: number
  checks?: { name: string; result: unknown }[]
  workerNavigation?: WatcherWorkerNavigation
}): PipelineRunNodeView[] {
  const canonicalId = input.kind === 'objective' ? 'objective' : 'pr-sitter'
  const run = builtinOneNodeRunState(input.kind, input.phase, input.progress, input.revision)
  const state = run.nodes.get(canonicalId)
  const documentNode = input.document.nodes[0]
  if (!state || !documentNode) {
    throw new Error('A legacy Heimdall pipeline run has no display node')
  }
  const turns = input.ledger.entries.reduce(
    (count, entry) => count + (entry.kind === 'turn' ? 1 : 0),
    0
  )
  return [
    {
      instanceId: documentNode.id,
      nodeId: documentNode.id,
      type: documentNode.type,
      label: input.displayLabel,
      status: state.status === 'ready' ? 'pending' : state.status,
      waitingFor: state.waitingFor ?? null,
      epoch: state.epoch,
      attempt: state.attempt,
      turns,
      ...(input.workerNavigation === undefined ? {} : { workerNavigation: input.workerNavigation }),
      ...(state.phase === undefined ? {} : { phase: state.phase }),
      ...(state.revision === undefined ? {} : { revision: state.revision }),
      ...(state.progress === undefined ? {} : { progress: state.progress }),
      ...(input.checks === undefined ? {} : { checks: input.checks })
    }
  ]
}

function edges(document: PipelineDocument): PipelineRunEdge[] {
  return document.nodes.flatMap((node) =>
    (node.after ?? []).map((edge) =>
      typeof edge === 'string'
        ? { from: edge, to: node.id }
        : { from: edge.node, to: node.id, when: edge.when }
    )
  )
}

function legacyWorkspaceKind(
  kind: LegacyPipelineKind,
  entry: WatcherListEntry,
  objectiveContract: ObjectiveEnrollmentPayload | undefined
): 'git' | 'folder' | 'unknown' {
  if (kind === 'objective') {
    return objectiveContract?.workspaceKind ?? 'unknown'
  }
  const workspace = entry.enrollment.worktreeId
  return workspace !== null && parseWorkspaceKey(workspace)?.type === 'folder' ? 'folder' : 'git'
}

function documentFromPinnedSource(input: {
  kind: LegacyPipelineKind
  pin: PipelinePin & { runNumber: number | null }
  pipelineSource: PipelineSourceSnapshot
  workspaceKind: 'git' | 'folder' | 'unknown'
}): PipelineDocument {
  const source = PipelineSourceSnapshotSchema.parse(input.pipelineSource)
  const parsed = parsePipelineText(source.sourceText)
  if (parsed.document === null || parsed.errors.length > 0) {
    throw new Error('Pinned pipeline source snapshot is invalid')
  }
  const validationErrors = validatePipeline(parsed.document, {
    workspaceKind: input.workspaceKind,
    expectedId: input.pin.id
  })
  if (
    validationErrors.length > 0 ||
    parsed.document.id !== input.pin.id ||
    pipelineContentHash(parsed.document) !== input.pin.contentHash ||
    routeEnrollmentKind(parsed.document) !== input.kind
  ) {
    throw new Error('Pinned pipeline source does not match its run pin')
  }
  return parsed.document
}

function legacyRunSnapshot(input: {
  kind: LegacyPipelineKind
  facts: PipelineStoreFacts
  pipelineSource?: PipelineSourceSnapshot
  entry: WatcherListEntry
  objectiveContract?: ObjectiveEnrollmentPayload
}): PinnedRun {
  const expectedId = input.kind === 'objective' ? 'objective' : 'pr-sitter'
  const builtinPin = builtinPipelinePin(expectedId)
  const pin = input.facts.pin ?? { ...builtinPin, runNumber: null }
  const workspaceKind = legacyWorkspaceKind(input.kind, input.entry, input.objectiveContract)
  if (input.pipelineSource !== undefined) {
    if (input.facts.pin === null) {
      throw new Error('Pinned pipeline source has no run pin')
    }
    return {
      pin,
      document: documentFromPinnedSource({
        kind: input.kind,
        pin,
        pipelineSource: input.pipelineSource,
        workspaceKind
      })
    }
  }
  if (pin.scope === 'repo' || pin.scope === 'user') {
    throw new Error('Pinned pipeline source snapshot is missing')
  }
  if (
    pin.scope !== 'builtin' ||
    pin.id !== expectedId ||
    pin.ref !== builtinPin.ref ||
    pin.contentHash !== builtinPin.contentHash
  ) {
    throw new Error('Legacy built-in pipeline run pin is invalid')
  }
  const text =
    input.kind === 'objective' ? BUILTIN_OBJECTIVE_PIPELINE_TEXT : BUILTIN_PR_SITTER_PIPELINE_TEXT
  return { pin, document: builtinDocument(text) }
}

/** Projects immutable run pins and current ledger/store facts into the renderer's dynamic run graph. */
export function projectPipelineRunView(input: {
  entry: WatcherListEntry
  ledger: WatcherLedger
  facts: PipelineStoreFacts
  objectiveDetail?: ObjectiveDetail
  pipelineSource?: PipelineSourceSnapshot
  nowMs: number
  workers?: readonly WatcherWorker[]
  unverifiableDispatchIds: ReadonlySet<string>
}): PipelineRunView {
  const kind = input.entry.enrollment.kind
  const workerNavigation = pipelineWorkerNavigationIndex(input.workers)
  let document: PipelineDocument
  let pin: PipelinePin & { runNumber: number | null }
  let nodes: PipelineRunNodeView[]
  let graphEdges: PipelineRunEdge[]

  if (kind === 'pipeline') {
    const payload = PipelineEnrollmentPayloadSchema.parse(input.entry.enrollment.kindPayload)
    document = payload.document
    pin = input.facts.pin ?? { ...payload.pin, runNumber: null }
    nodes = projectPipelineRunNodes({
      entry: input.entry,
      payload,
      ledger: input.ledger,
      facts: input.facts,
      nowMs: input.nowMs,
      unverifiableDispatchIds: input.unverifiableDispatchIds,
      workerNavigation
    })
    graphEdges = edges(document)
  } else {
    const objectiveContract =
      kind === 'objective'
        ? ObjectiveEnrollmentPayloadSchema.parse(input.entry.enrollment.kindPayload)
        : undefined
    const snapshot = legacyRunSnapshot({
      kind,
      facts: input.facts,
      entry: input.entry,
      objectiveContract,
      ...(input.pipelineSource === undefined ? {} : { pipelineSource: input.pipelineSource })
    })
    document = snapshot.document
    pin = snapshot.pin
    const builtinId = kind === 'objective' ? 'objective' : 'pr-sitter'
    const displayNode = document.nodes[0]
    if (!displayNode) {
      throw new Error('A legacy Heimdall pipeline document has no node')
    }
    const displayLabel =
      input.pipelineSource === undefined
        ? `${document.name} v${pin.documentVersion}`
        : (displayNode.label ?? document.name)
    if (kind === 'objective') {
      if (objectiveContract === undefined) {
        throw new Error('An Objective pipeline run has no enrollment contract')
      }
      const progress = objectiveProgress(input.objectiveDetail)
      const phase = objectiveCompositePhase(
        input.objectiveDetail ?? null,
        pipelinePlanReviewInFlight(input.ledger)
          ? 'plan-review-in-flight'
          : input.entry.status.phase
      )
      nodes = builtinNodeView({
        kind,
        document,
        displayLabel,
        phase,
        ledger: input.ledger,
        workerNavigation: workerNavigation.latest,
        ...progress,
        checks: objectiveChecks(objectiveContract, input.objectiveDetail)
      })
    } else {
      nodes = builtinNodeView({
        kind,
        document,
        displayLabel,
        phase: sitterCompositePhase(input.ledger),
        ledger: input.ledger,
        workerNavigation: workerNavigation.latest
      })
    }
    if (displayNode.id !== builtinId && input.pipelineSource === undefined) {
      throw new Error('Legacy built-in pipeline node identity is invalid')
    }
    graphEdges = edges(document)
  }

  return PipelineRunViewSchema.parse({
    watcherId: input.entry.enrollment.watcherId,
    kind,
    pin: { ...pin, label: `${document.name} v${pin.documentVersion}` },
    document,
    nodes,
    edges: graphEdges,
    asOfMs: input.nowMs
  })
}
