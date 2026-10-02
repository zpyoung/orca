import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type {
  AcceptedWorkerCompletionContext,
  ExecuteContext,
  KernelAction,
  LeaseGuard,
  PreflightContext,
  SubmissionAdapter
} from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import { executePipelineChoice, resolvePipelineChoiceOutcome } from './choice-executor'
import type { PipelineChoiceExecutorDependencies } from './choice-executor'
import { createPipelineSubmissionAdapter } from './submission-preflight'
import { createPipelineAgentActions } from './pipeline-action-dispatch-agent'
import { isPipelineAgentReportActionKind } from './agent-node-executor'
import { createPipelineAgentReportContext } from './pipeline-action-dispatch-reports'
import { createPipelineMergeActions } from './pipeline-action-dispatch-merge'
import { validatePipelineMergeResolver } from './pipeline-merge-resolver'
import {
  executePipelineLandAction,
  pipelineLandAttemptExpectation,
  pipelineLandPreflight,
  resolvePipelineLandOutcome
} from './pipeline-action-dispatch-land'
import { cacheWorld, currentIdentityMatches, attemptIsCurrent } from './pipeline-action-identity'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'
import {
  ALLOW,
  type PipelineActionDispatchContext,
  type PipelineActionDispatcher,
  type PipelineActionDispatcherDependencies
} from './pipeline-action-dispatch-contracts'

export type {
  PipelineActionDispatcher,
  PipelineActionDispatcherDependencies
} from './pipeline-action-dispatch-contracts'
export type { PipelineCompositeActionAdapter } from './pipeline-kind'

export function createPipelineActionDispatcher(
  dependencies: PipelineActionDispatcherDependencies
): PipelineActionDispatcher {
  const worlds = new Map<string, PipelineReadyWorld>()
  const choiceDependencies: PipelineChoiceExecutorDependencies = {
    store: dependencies.pipelineStore
  }
  const resolveReportContext = createPipelineAgentReportContext(
    dependencies,
    worlds,
    (action, world, ledger) => validatePipelineMergeResolver(action, world, ledger) !== null
  )
  const shared: PipelineActionDispatchContext = { dependencies, worlds, resolveReportContext }
  const agentActions = createPipelineAgentActions(shared)
  const mergeActions = createPipelineMergeActions(shared)
  const agentSubmission = createPipelineSubmissionAdapter({
    store: dependencies.pipelineStore,
    resolveReportContext
  })

  async function execute(
    action: KernelAction,
    context: ExecuteContext<PipelineKindWorld>
  ): Promise<ActionOutcome> {
    const world = cacheWorld(context.snapshot, worlds)
    if (world === null) {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'pipeline-configuration-invalid'
      }
    }
    const identity = currentIdentityMatches(action, world, context.ledger)
    if (identity === null) {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'pipeline-action-identity-stale'
      }
    }
    const composite = dependencies.compositeActions
    if (action.kind === 'pipeline-activate-composite' || composite.handles(action)) {
      return await composite.execute(action, context)
    }
    const agent = await agentActions.execute(action, world, identity, context)
    if (agent !== null) {
      return agent
    }
    const merge = await mergeActions.execute(action, world, identity, context)
    if (merge !== null) {
      return merge
    }
    if (action.kind.startsWith('pipeline-land-')) {
      return await executePipelineLandAction(action, context, world, dependencies)
    }
    switch (action.kind) {
      case 'pipeline-apply-choice':
      case 'pipeline-pass-gate':
        return await executePipelineChoice(action, context, choiceDependencies)
      default:
        throw new Error(`Unsupported pipeline action kind: ${action.kind}`)
    }
  }

  async function resolveOutcome(
    attempt: AttemptEntry,
    fresh: LiveSnapshot<PipelineKindWorld>,
    ledger: WatcherLedger,
    lease: LeaseGuard
  ): Promise<EffectCertaintyResolution> {
    const world = cacheWorld(fresh, worlds)
    if (world === null) {
      return { effect: 'indeterminate' }
    }
    const identity = attemptIsCurrent(attempt, world, ledger)
    if (identity === null) {
      return { effect: 'indeterminate' }
    }
    const action = attempt.action
    const composite = dependencies.compositeActions
    if (action.kind === 'pipeline-activate-composite' || composite.handles(action)) {
      return await composite.resolveOutcome(attempt, fresh, ledger, lease)
    }
    const agent = await agentActions.resolveOutcome(attempt, fresh, identity, lease)
    if (agent !== null) {
      return agent
    }
    const merge = await mergeActions.resolveOutcome(attempt, world, ledger, identity, lease)
    if (merge !== null) {
      return merge
    }
    if (action.kind.startsWith('pipeline-land-')) {
      return await resolvePipelineLandOutcome(attempt, action, world, ledger, lease, dependencies)
    }
    switch (action.kind) {
      case 'pipeline-apply-choice':
      case 'pipeline-pass-gate':
        return resolvePipelineChoiceOutcome(attempt, fresh, ledger, lease)
      default:
        return { effect: 'indeterminate' }
    }
  }

  async function resolveAcceptedWorkerCompletion(
    completion: AcceptedWorkerCompletionContext
  ): Promise<EffectCertaintyResolution | null> {
    const { attempt, dispatchId, lease, ledger } = completion
    if (!isPipelineAgentReportActionKind(attempt.action.kind)) {
      return null
    }
    if (attempt.dispatchId !== dispatchId) {
      return { effect: 'indeterminate' }
    }
    if (attempt.action.kind === 'pipeline-resolve-merge-conflict') {
      const world = worlds.get(attempt.watcherId)
      if (world === undefined) {
        return { effect: 'indeterminate' }
      }
      const identity = attemptIsCurrent(attempt, world, ledger)
      if (identity === null) {
        return { effect: 'indeterminate' }
      }
      await lease.assertHeld()
      const resolution = await mergeActions.resolveOutcome(attempt, world, ledger, identity, lease)
      await lease.assertHeld()
      return resolution ?? { effect: 'indeterminate' }
    }
    return (
      (await agentActions.resolveAcceptedWorkerCompletion(completion)) ?? {
        effect: 'indeterminate'
      }
    )
  }

  async function preflight(
    action: KernelAction,
    snapshot: Snapshot<PipelineKindWorld>,
    ledger: WatcherLedger,
    context: PreflightContext
  ): Promise<GateVerdict> {
    const world = cacheWorld(snapshot, worlds)
    if (world === null) {
      return { verdict: 'hold', reason: 'Pipeline configuration is invalid.' }
    }
    if (
      context.enrollment.watcherId !== world.watcherId ||
      currentIdentityMatches(action, world, ledger) === null
    ) {
      return { verdict: 'hold', reason: 'Pipeline action identity is stale.' }
    }
    const composite = dependencies.compositeActions
    if (action.kind === 'pipeline-activate-composite' || composite.handles(action)) {
      return composite.preflight === undefined
        ? ALLOW
        : await composite.preflight(action, snapshot, ledger, context)
    }
    const mergeReason = await mergeActions.preflight(action, world, ledger)
    if (mergeReason !== null) {
      return { verdict: 'hold', reason: mergeReason }
    }
    const landReason = pipelineLandPreflight(action, world, ledger)
    if (landReason !== null) {
      return { verdict: 'hold', reason: landReason }
    }
    return ALLOW
  }

  const submission: SubmissionAdapter<PipelineKindWorld> = {
    async preflightWorkerReport(report, context) {
      if (context.snapshot !== null) {
        cacheWorld(context.snapshot, worlds)
      }
      const agent = await agentSubmission.preflightWorkerReport(report, context)
      if (agent.status !== 'accepted') {
        return agent
      }
      const preflight = dependencies.compositeActions.preflightSubmission
      return preflight === undefined ? agent : await preflight(report, context)
    }
  }

  function attemptExpectation(
    action: KernelAction,
    snapshot: Snapshot<PipelineKindWorld>
  ): { expectedBefore: string; expectedAfter: string } | undefined {
    const world = cacheWorld(snapshot, worlds)
    if (world === null) {
      return undefined
    }
    const composite = dependencies.compositeActions
    if (action.kind === 'pipeline-activate-composite' || composite.handles(action)) {
      return composite.attemptExpectation?.(action, snapshot)
    }
    return pipelineLandAttemptExpectation(action)
  }

  return {
    execute,
    resolveOutcome,
    preflight,
    attemptExpectation,
    resolveReportContext,
    resolveAcceptedWorkerCompletion,
    submission
  }
}
