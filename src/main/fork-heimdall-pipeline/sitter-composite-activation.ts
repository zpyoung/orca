import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext, KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { AuthorizedEnrollment, EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PipelinePrSitterNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import { derivePipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter'
import { pipelineNodeIdentity } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'
import { isPipelineInvalidConfigurationWorld } from './pipeline-kind-read'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import { authorizeHostedReviewSitterDefinition } from '../fork-hosted-review-sitter/definition'
import { parseHostedReviewEnrollmentPayload } from '../fork-hosted-review-sitter/definition-store'
import type { PipelineStore } from './pipeline-store'

export type SitterCompositeActivationDependencies = Readonly<{
  runtime: OrcaRuntimeService
  store: Store
  pipelineStore: PipelineStore
  storageAuthority: 'desktop' | 'runtime'
}>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function activationFacts(
  world: PipelineReadyWorld,
  action: KernelAction,
  ledger: WatcherLedger
): Readonly<{
  node: PipelinePrSitterNode
  epoch: number
  landInstanceId: string
  prUrl: string
  prNumber: number
  branch: string
  provider: 'github' | 'gitlab'
}> | null {
  const identity = pipelineNodeIdentity(action)
  if (identity === null || identity.inner !== undefined) {
    return null
  }
  const node = world.payload.document.nodes.find(
    (candidate): candidate is PipelinePrSitterNode =>
      candidate.id === identity.nodeId && candidate.type === 'pr-sitter'
  )
  const land = world.payload.document.nodes.find((candidate) => candidate.type === 'land')
  if (!node || !land) {
    return null
  }
  const state = derivePipelineRunState({
    payload: world.payload,
    ledger,
    facts: world.facts,
    nowMs: world.nowMs,
    hasOwner: world.hasOwner,
    unverifiableDispatchIds: world.unverifiableDispatchIds,
    composites: world.composites
  })
  const sitterState = state.nodes.get(node.id)
  if (sitterState?.status !== 'ready') {
    return null
  }
  const landState = state.nodes.get(land.id)
  const outputs = landState?.status === 'done' ? landState.outputs : undefined
  const prUrl = outputs?.prUrl
  const prNumber = outputs?.prNumber
  const branch = outputs?.branch
  const provider = outputs?.provider
  if (
    typeof prUrl !== 'string' ||
    typeof prNumber !== 'number' ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    typeof branch !== 'string' ||
    branch.length === 0 ||
    (provider !== 'github' && provider !== 'gitlab') ||
    action.landInstanceId !== land.id ||
    action.prUrl !== prUrl ||
    action.prNumber !== prNumber ||
    action.branch !== branch ||
    action.provider !== provider
  ) {
    return null
  }
  return {
    node,
    epoch: sitterState.epoch,
    landInstanceId: land.id,
    prUrl,
    prNumber,
    branch,
    provider
  }
}

function actionSettingsMatch(action: KernelAction, node: PipelinePrSitterNode): boolean {
  return (
    action.branchUpdateMode === node.branchUpdateMode &&
    action.mergeMethod === node.mergeMethod &&
    action.mergeCheckScope === node.mergeCheckScope &&
    action.repeatFixLimit === node.repeatFixLimit
  )
}

function activationRefusal(reason: string): ActionOutcome {
  return { effect: 'not-landed', failureClass: 'criteria', reason }
}

/** Authorizes and persists a sitter composite from the currently landed Land outputs. */
export async function executeSitterCompositeActivation(
  action: KernelAction,
  context: ExecuteContext<PipelineKindWorld>,
  dependencies: SitterCompositeActivationDependencies
): Promise<ActionOutcome> {
  const snapshot = context.snapshot
  if (isPipelineInvalidConfigurationWorld(snapshot.world)) {
    return activationRefusal(snapshot.world.invalidConfiguration.detail)
  }
  const world = snapshot.world
  const identity = pipelineNodeIdentity(action)
  const landed = activationFacts(world, action, context.ledger)
  if (
    identity === null ||
    identity.inner !== undefined ||
    landed === null ||
    identity.epoch !== landed.epoch ||
    !actionSettingsMatch(action, landed.node)
  ) {
    return activationRefusal('The PR-sitter activation no longer matches its landed Pull Request')
  }
  const appendEvidence = context.appendEvidence
  if (appendEvidence === undefined) {
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: 'Scoped pipeline evidence is unavailable'
    }
  }
  const kindPayload = {
    branchUpdateMode: landed.node.branchUpdateMode ?? 'merge-base-update',
    mergeMethod: landed.node.mergeMethod ?? null,
    mergeCheckScope: landed.node.mergeCheckScope,
    repeatFixLimit: landed.node.repeatFixLimit
  }
  const capabilities = {
    updateBranch: world.grants.updateBranch ?? 'off',
    resolveConflicts: world.grants.resolveConflicts ?? 'off',
    fixChecks: world.grants.fixChecks ?? 'off',
    merge: world.grants.merge ?? 'off'
  }
  const input: EnrollInput = {
    kind: 'hosted-review',
    repoId: world.enrollment.repoId,
    worktreeId: world.enrollment.worktreeId,
    capabilities,
    budget: world.enrollment.budget,
    kindPayload
  }

  let authorized: AuthorizedEnrollment
  try {
    authorized = await authorizeHostedReviewSitterDefinition(
      dependencies.runtime,
      dependencies.store,
      input,
      dependencies.storageAuthority
    )
  } catch (error) {
    return { effect: 'not-landed', failureClass: 'infra', reason: errorText(error) }
  }
  const authorizedPayload = parseHostedReviewEnrollmentPayload(authorized.kindPayload)
  if (
    authorized.kind !== 'hosted-review' ||
    authorized.workspaceKey !== world.enrollment.workspaceKey ||
    authorized.executionHostId !== world.enrollment.executionHostId ||
    authorized.repoId !== world.enrollment.repoId ||
    authorized.worktreeId !== world.enrollment.worktreeId ||
    authorized.workspacePath !== world.enrollment.workspacePath ||
    authorized.capabilities.updateBranch !== capabilities.updateBranch ||
    authorized.capabilities.resolveConflicts !== capabilities.resolveConflicts ||
    authorized.capabilities.fixChecks !== capabilities.fixChecks ||
    authorized.capabilities.merge !== capabilities.merge ||
    authorizedPayload === null ||
    authorizedPayload.branch !== landed.branch ||
    authorizedPayload.provider !== landed.provider ||
    authorizedPayload.reviewNumber !== landed.prNumber ||
    authorizedPayload.reviewUrl !== landed.prUrl ||
    authorizedPayload.branchUpdateMode !== kindPayload.branchUpdateMode ||
    authorizedPayload.mergeMethod !== kindPayload.mergeMethod ||
    authorizedPayload.mergeCheckScope !== kindPayload.mergeCheckScope ||
    authorizedPayload.repeatFixLimit !== kindPayload.repeatFixLimit
  ) {
    return activationRefusal(
      'The authorized hosted review no longer matches Land output and PR-sitter settings'
    )
  }

  try {
    dependencies.pipelineStore.recordComposite({
      watcherId: world.enrollment.watcherId,
      instanceId: identity.instanceId,
      epoch: identity.epoch,
      kind: 'hosted-review',
      kindPayload: authorized.kindPayload,
      capabilities: authorized.capabilities,
      activatedAtMs: world.nowMs
    })
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: `Could not persist sitter activation: ${errorText(error)}`
    }
  }
  try {
    await appendEvidence('pipeline-composite-activated', {
      instanceId: identity.instanceId,
      kind: 'hosted-review',
      kindPayload: authorized.kindPayload,
      capabilities: authorized.capabilities,
      landInstanceId: landed.landInstanceId,
      prUrl: landed.prUrl
    })
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: `Could not record sitter activation evidence: ${errorText(error)}`
    }
  }
  return {
    effect: 'landed',
    result: { kind: 'composite-activated', instanceId: identity.instanceId }
  }
}
