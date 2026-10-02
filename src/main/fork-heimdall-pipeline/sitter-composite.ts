import { z } from 'zod'
import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type {
  ExecuteContext,
  KernelAction,
  OwnerInterventionRejection,
  OwnerStateBrief,
  PreflightContext,
  SubmissionPreflightResult
} from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Intervention } from '../../shared/fork-heimdall/owner/intervention'
import { getInFlightAttempts, getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import {
  RetryRungInterventionSchema,
  SkipCapabilityInterventionSchema,
  type HostedReviewSitterSpecificIntervention
} from '../../shared/fork-hosted-review-sitter/owner-intervention'
import type { HostedReviewWorld } from '../../shared/fork-hosted-review-sitter/types'
import { pipelineNodeIdentity } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import {
  unwrapCompositeAction,
  type PipelineComposite
} from '../../shared/fork-heimdall-pipeline/interpreter'
import { derivePipelineHistory } from '../../shared/fork-heimdall-pipeline/interpreter/state-history'
import { pipelineNodeEpoch } from '../../shared/fork-heimdall-pipeline/interpreter/run-state-actions'
import type { PipelinePrSitterNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import type {
  PipelineCompositeActionAdapter,
  PipelineCompositeOwnerDelegate
} from './pipeline-kind'
import type { PipelineCompositeReadInput, PipelineCompositeReadResult } from './pipeline-kind-read'
import {
  CompositeNodeConfigurationError,
  compareCompositeAttemptProtectedFiles,
  compositeProtectedOutcome,
  compositeProtectedSubmissionResult,
  createCompositeNodeHost,
  dispatchCompositeWorkerWithProtectedBaseline
} from './composite-node-host'
import type { HostedReviewKind } from '../fork-hosted-review-sitter/kind'
import {
  activeComposite,
  hostedReviewLiveSnapshot,
  hostedReviewSnapshot,
  isSitterAction,
  requireWrappedSitterAction,
  sitterEnrollment
} from './sitter-composite-identity'
import { executeSitterCompositeActivation } from './sitter-composite-activation'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PipelineStore } from './pipeline-store'

const SITTER_WORKER_ACTION_KINDS: Readonly<
  Record<'prepare-fix' | 'prepare-conflict-resolution', true>
> = {
  'prepare-fix': true,
  'prepare-conflict-resolution': true
}
const SITTER_ONLY_INTERVENTION_SCHEMA = z
  .preprocess(
    (value) => value,
    z.discriminatedUnion('kind', [RetryRungInterventionSchema, SkipCapabilityInterventionSchema])
  )
  .transform((value): Intervention => value)

export type SitterCompositeAdapterDependencies = Readonly<{
  runtime: OrcaRuntimeService
  store: Store
  pipelineStore: PipelineStore
  hostedReviewKind: HostedReviewKind
  storageAuthority: 'desktop' | 'runtime'
}>

export type SitterCompositeAdapters = Readonly<{
  readComposites(input: PipelineCompositeReadInput): Promise<PipelineCompositeReadResult>
  compositeActions: PipelineCompositeActionAdapter
  compositeOwner: PipelineCompositeOwnerDelegate
}>

function isSitterWorkerAttempt(attempt: AttemptEntry): boolean {
  const identity = pipelineNodeIdentity(attempt.action)
  return (
    Object.hasOwn(SITTER_WORKER_ACTION_KINDS, attempt.action.kind) &&
    identity !== null &&
    identity.inner !== undefined
  )
}

function isSitterIntervention(
  intervention: Intervention
): intervention is HostedReviewSitterSpecificIntervention {
  return intervention.kind === 'retry-rung' || intervention.kind === 'skip-capability'
}

function compositeForRead(
  input: PipelineCompositeReadInput,
  node: PipelinePrSitterNode,
  epoch: number,
  dependencies: SitterCompositeAdapterDependencies
): Promise<PipelineComposite> {
  return readComposite()

  async function readComposite(): Promise<PipelineComposite> {
    const row = input.facts.composites.find(
      (fact) => fact.instanceId === node.id && fact.epoch === epoch
    )
    if (!row || row.kind !== 'hosted-review') {
      throw new CompositeNodeConfigurationError(
        node.id,
        epoch,
        'The activated PR-sitter composite is missing from pipeline storage'
      )
    }
    const enrollment = sitterEnrollment(
      input.enrollment,
      row.kindPayload,
      row.capabilities,
      node.id,
      epoch
    )
    const host = createCompositeNodeHost(
      dependencies.hostedReviewKind,
      { kind: 'node-scoped', instanceId: node.id, epoch },
      input.runContentIdentity
    )
    const snapshot = await host.read(enrollment, { fresh: input.fresh })
    return {
      snapshot,
      phase: host.phase(snapshot, input.ledger),
      decide: () => host.decide(snapshot, input.ledger),
      evaluateStops: () => host.evaluateStops(snapshot, input.ledger)
    }
  }
}

function matchingSitterWorkerAttempt(
  ledger: WatcherLedger,
  dispatchId: string
): AttemptEntry | null {
  const attempts = getLatestAttempts(ledger).filter(isSitterWorkerAttempt)
  const exact = attempts.findLast((attempt) => attempt.dispatchId === dispatchId)
  if (exact) {
    return exact
  }
  const inFlight = getInFlightAttempts(ledger).filter(isSitterWorkerAttempt)
  return inFlight.length === 1 ? (inFlight[0] ?? null) : null
}

function activationOutcome(
  attempt: AttemptEntry,
  dependencies: SitterCompositeAdapterDependencies
): EffectCertaintyResolution {
  const identity = pipelineNodeIdentity(attempt.action)
  if (identity === null) {
    return { effect: 'indeterminate' }
  }
  try {
    return dependencies.pipelineStore.composite(
      attempt.watcherId,
      identity.instanceId,
      identity.epoch
    ) === null
      ? { effect: 'not-landed' }
      : { effect: 'landed' }
  } catch {
    return { effect: 'indeterminate' }
  }
}

function handlesCompositeAction(action: KernelAction): boolean {
  return (
    action.kind === 'pipeline-activate-composite' ||
    (isSitterAction(action) &&
      pipelineNodeIdentity(action)?.inner !== undefined &&
      unwrapCompositeAction(action) !== null)
  )
}

function actionAdapter(
  dependencies: SitterCompositeAdapterDependencies
): PipelineCompositeActionAdapter {
  return {
    handles: handlesCompositeAction,
    attemptExpectation(action, snapshot) {
      if (action.kind === 'pipeline-activate-composite' || !handlesCompositeAction(action)) {
        return undefined
      }
      const composite = activeComposite(snapshot, action, dependencies.hostedReviewKind)
      return composite.host.attemptExpectation?.(
        requireWrappedSitterAction(action, snapshot.contentIdentity),
        composite.snapshot
      )
    },
    async preflight(action, snapshot, ledger, _context: PreflightContext): Promise<GateVerdict> {
      if (action.kind === 'pipeline-activate-composite') {
        return { verdict: 'allow' }
      }
      const composite = activeComposite(snapshot, action, dependencies.hostedReviewKind)
      if (composite.host.preflight === undefined) {
        return { verdict: 'allow' }
      }
      return await composite.host.preflight(
        requireWrappedSitterAction(action, snapshot.contentIdentity),
        composite.snapshot,
        ledger,
        { enrollment: composite.enrollment }
      )
    },
    async execute(action, context): Promise<ActionOutcome> {
      if (action.kind === 'pipeline-activate-composite') {
        return await executeSitterCompositeActivation(action, context, dependencies)
      }
      const composite = activeComposite(context.snapshot, action, dependencies.hostedReviewKind)
      const wrappedAction = requireWrappedSitterAction(action, context.snapshot.contentIdentity)
      const appendEvidence = context.appendEvidence
      const innerContext: ExecuteContext<HostedReviewWorld> = {
        snapshot: composite.snapshot,
        lease: context.lease,
        ledger: context.ledger,
        dispatchWorker: (request) =>
          dispatchCompositeWorkerWithProtectedBaseline({
            request,
            action,
            enrollment: composite.enrollment,
            dispatchWorker: context.dispatchWorker,
            pipelineStore: dependencies.pipelineStore
          }),
        ...(appendEvidence === undefined
          ? {}
          : { appendEvidence: (evidenceKind, payload) => appendEvidence(evidenceKind, payload) })
      }
      return await composite.host.execute(wrappedAction, innerContext)
    },
    async resolveOutcome(attempt, fresh, ledger, lease): Promise<EffectCertaintyResolution> {
      if (attempt.action.kind === 'pipeline-activate-composite') {
        return activationOutcome(attempt, dependencies)
      }
      const composite = activeComposite(fresh, attempt.action, dependencies.hostedReviewKind)
      if (isSitterWorkerAttempt(attempt)) {
        const comparison = await compareCompositeAttemptProtectedFiles(
          attempt,
          composite.enrollment,
          dependencies.pipelineStore
        )
        const protectedOutcome = compositeProtectedOutcome(attempt, comparison)
        if (protectedOutcome !== null) {
          return protectedOutcome
        }
      }
      const innerFresh = hostedReviewLiveSnapshot(composite.snapshot)
      if (!innerFresh) {
        return { effect: 'indeterminate' }
      }
      return await composite.host.resolveOutcome(attempt, innerFresh, ledger, lease)
    },
    async preflightSubmission(submission, context): Promise<SubmissionPreflightResult> {
      const attempt = matchingSitterWorkerAttempt(context.ledger, submission.dispatchId)
      if (attempt === null) {
        return { status: 'accepted' }
      }
      const comparison = await compareCompositeAttemptProtectedFiles(
        attempt,
        context.enrollment,
        dependencies.pipelineStore
      )
      return compositeProtectedSubmissionResult(comparison)
    }
  }
}

function ownerDelegate(hostedReviewKind: HostedReviewKind): PipelineCompositeOwnerDelegate {
  const owner = hostedReviewKind.owner
  if (!owner) {
    throw new Error('The hosted-review kind has no owner adapter')
  }
  return {
    interventionSchema: SITTER_ONLY_INTERVENTION_SCHEMA,
    isSitterIntervention,
    describeInterventions: () => owner.describeInterventions(),
    describeState(input): OwnerStateBrief {
      return owner.describeState(
        hostedReviewSnapshot(input.innerSnapshot),
        input.scopedLedger,
        input.maxBytes,
        { deviation: input.deviation }
      )
    },
    rejectIntervention(intervention, context): OwnerInterventionRejection | null {
      if (!isSitterIntervention(intervention)) {
        return {
          gate: 'pipeline-choice',
          reason: 'Only a PR-sitter-specific intervention can answer this node deviation'
        }
      }
      return owner.rejectIntervention(
        intervention,
        hostedReviewSnapshot(context.innerSnapshot),
        context.scopedLedger,
        context.enrollment
      )
    },
    actionForIntervention(intervention, context): KernelAction {
      if (!isSitterIntervention(intervention)) {
        throw new Error('The PR-sitter owner adapter received a non-sitter intervention')
      }
      return owner.actionForIntervention(
        intervention,
        hostedReviewSnapshot(context.innerSnapshot),
        context.scopedLedger
      )
    }
  }
}

export function createSitterCompositeAdapters(
  dependencies: SitterCompositeAdapterDependencies
): SitterCompositeAdapters {
  const readComposites = async (
    input: PipelineCompositeReadInput
  ): Promise<PipelineCompositeReadResult> => {
    const history = derivePipelineHistory(input.payload.document, input.ledger)
    const composites: Record<string, PipelineComposite> = {}
    for (const node of input.payload.document.nodes) {
      if (node.type !== 'pr-sitter') {
        continue
      }
      const epoch = pipelineNodeEpoch(history, node.id)
      const activation = input.facts.composites.find(
        (fact) => fact.instanceId === node.id && fact.epoch === epoch
      )
      if (!activation) {
        continue
      }
      try {
        composites[node.id] = await compositeForRead(input, node, epoch, dependencies)
      } catch (cause) {
        if (cause instanceof CompositeNodeConfigurationError) {
          throw cause
        }
        throw new CompositeNodeConfigurationError(node.id, epoch, cause)
      }
    }
    return { composites }
  }

  return {
    readComposites,
    compositeActions: actionAdapter(dependencies),
    compositeOwner: ownerDelegate(dependencies.hostedReviewKind)
  }
}
