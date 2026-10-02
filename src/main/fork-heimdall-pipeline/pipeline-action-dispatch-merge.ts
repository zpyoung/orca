import { isDeepStrictEqual } from 'node:util'
import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import { mergeChild, readMergeSourceFacts } from './merge-executor'
import type { MergeChildInput } from './merge-executor'
import type { PipelineReadyWorld, PipelineKindWorld } from './pipeline-kind-read'
import { parsePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineActionDispatchContext } from './pipeline-action-dispatch-contracts'
import {
  appliedChildren,
  childWorktreeFact,
  currentIdentityMatches,
  latestProgress,
  originalMergeStep,
  record,
  runState,
  sourceMatchesMergeAction,
  text,
  type Identity
} from './pipeline-action-identity'
import { assertRunWorkspace, childContext, readHead } from './pipeline-action-dispatch-workspace'
import {
  readPipelineMergeResolverSource,
  validatePipelineMergeResolver
} from './pipeline-merge-resolver'
import {
  executePipelineConflictResolver,
  resolvePipelineConflictResolverOutcome
} from './pipeline-action-dispatch-conflict-resolver'

function mergeActionIsFresh(
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger
): boolean {
  const identity = currentIdentityMatches(action, world, ledger)
  if (
    identity === null ||
    action.kind !== 'pipeline-merge-child' ||
    action.capability !== 'integrate'
  ) {
    return false
  }
  const merge = world.payload.document.nodes.find(
    (candidate) => candidate.type === 'merge' && candidate.id === identity.nodeId
  )
  const source = text(action, 'childInstanceId')
  const facts = source === null ? undefined : world.mergeSources?.[source]
  if (merge?.type !== 'merge' || facts === undefined) {
    return false
  }
  const swarm = world.payload.document.nodes.find(
    (candidate) => candidate.type === 'swarm' && candidate.id === merge.from
  )
  if (swarm?.type !== 'swarm') {
    return false
  }
  if (swarm.worktree === 'own' ? facts.workspacePath === null : facts.workspacePath !== null) {
    return false
  }
  return sourceMatchesMergeAction(action, world, facts)
}

async function executeMergeChild(
  action: KernelAction,
  world: PipelineReadyWorld,
  identity: Identity,
  context: ExecuteContext<PipelineKindWorld>,
  dependencies: PipelineActionDispatchContext['dependencies']
): Promise<ActionOutcome> {
  if (!mergeActionIsFresh(action, world, context.ledger)) {
    return { effect: 'not-landed', failureClass: 'criteria', reason: 'pipeline-merge-source-stale' }
  }
  const childInstanceId = text(action, 'childInstanceId')
  const mergeId = text(action, 'mergeId')
  const taskId = text(action, 'taskId')
  const baseCommit = text(action, 'baseCommit')
  const sourceHead = text(action, 'sourceHead')
  const workspaceDigest = text(action, 'workspaceDigest')
  const childWorkspacePath = action.childWorkspacePath
  const childCommitSha = action.childCommitSha
  const children = appliedChildren(action)
  if (
    childInstanceId === null ||
    mergeId === null ||
    taskId === null ||
    baseCommit === null ||
    sourceHead === null ||
    workspaceDigest === null ||
    (typeof childWorkspacePath !== 'string' && childWorkspacePath !== null) ||
    (typeof childCommitSha !== 'string' && childCommitSha !== null) ||
    children === null
  ) {
    return {
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: 'pipeline-merge-action-invalid'
    }
  }
  const source = world.mergeSources?.[childInstanceId]
  if (source === undefined) {
    return {
      effect: 'indeterminate',
      failureClass: 'infra',
      reason: 'pipeline-merge-source-unavailable'
    }
  }
  try {
    await context.lease.assertHeld()
    const runTarget = await resolveObjectiveWorkspaceTarget(dependencies.runtime, world.enrollment)
    assertRunWorkspace(world, runTarget)
    const childState = runState(world, context.ledger).nodes.get(childInstanceId)
    const childRecord =
      source.workspacePath === null || childState === undefined
        ? null
        : childWorktreeFact(world.facts, childInstanceId, childState.epoch)
    if (
      source.workspacePath !== null &&
      (childRecord === null || childRecord.setupState !== 'ready')
    ) {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'pipeline-child-worktree-unavailable'
      }
    }
    const childTarget =
      childRecord === null
        ? null
        : await childContext(action, world, dependencies.runtime, childRecord)
    const targetForPath = async (workspacePath: string): Promise<ObjectiveWorkspaceTarget> => {
      if (workspacePath === runTarget.workspacePath) {
        return runTarget
      }
      if (childTarget !== null && workspacePath === childTarget.workspacePath) {
        return childTarget
      }
      throw new Error('Pipeline Merge source path is not an enrolled or recorded child workspace')
    }
    const sourceNow = await readMergeSourceFacts(
      {
        watcherId: world.watcherId,
        mergeId,
        epoch: identity.epoch,
        childInstanceId,
        workspacePath: source.workspacePath,
        runWorkspacePath: runTarget.workspacePath,
        applicableBaseCommit: baseCommit,
        childCommitSha
      },
      { store: dependencies.pipelineStore, resolveTarget: targetForPath }
    )
    if (!sourceMatchesMergeAction(action, world, sourceNow)) {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'pipeline-merge-source-stale'
      }
    }
    const mergeInput: MergeChildInput = {
      watcherId: world.watcherId,
      mergeId,
      epoch: identity.epoch,
      child: { instanceId: childInstanceId, taskId, workspacePath: source.workspacePath },
      runWorkspacePath: runTarget.workspacePath,
      baseCommit,
      childCommitSha,
      sourceHead,
      workspaceDigest,
      appliedChildren: children
    }
    const result = await mergeChild(mergeInput, {
      store: dependencies.pipelineStore,
      lease: context.lease,
      resolveTarget: targetForPath
    })
    return result.status === 'applied'
      ? { effect: 'landed', result: { appliedCommitSha: result.appliedCommitSha } }
      : {
          effect: 'not-landed',
          failureClass: 'criteria',
          reason: 'merge-conflict',
          result: {
            conflictPaths: result.conflictPaths,
            conflictingChildren: result.conflictingChildren
          }
        }
  } catch (error) {
    return {
      effect: 'indeterminate',
      failureClass: 'infra',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

async function resolveMergeChildOutcome(
  action: KernelAction,
  attempt: AttemptEntry,
  world: PipelineReadyWorld,
  identity: Identity,
  lease: LeaseGuard,
  shared: PipelineActionDispatchContext
): Promise<EffectCertaintyResolution> {
  const childInstanceId = text(action, 'childInstanceId')
  const mergeId = text(action, 'mergeId')
  const taskId = text(action, 'taskId')
  const baseCommit = text(action, 'baseCommit')
  const sourceHead = text(action, 'sourceHead')
  const workspaceDigest = text(action, 'workspaceDigest')
  const childWorkspacePath = action.childWorkspacePath
  const childCommitSha = action.childCommitSha
  if (
    action.kind !== 'pipeline-merge-child' ||
    action.capability !== 'integrate' ||
    world.grants.integrate === 'off' ||
    childInstanceId === null ||
    mergeId === null ||
    taskId === null ||
    baseCommit === null ||
    sourceHead === null ||
    workspaceDigest === null ||
    (typeof childWorkspacePath !== 'string' && childWorkspacePath !== null) ||
    (typeof childCommitSha !== 'string' && childCommitSha !== null) ||
    identity.nodeId !== mergeId
  ) {
    return { effect: 'indeterminate' }
  }
  const expectedStep = originalMergeStep(action)
  if (
    expectedStep === null ||
    parsePipelineNodeEvidenceKey(action.evidenceKey)?.step !== expectedStep
  ) {
    return { effect: 'indeterminate' }
  }
  const progress = latestProgress(
    shared.dependencies.pipelineStore.facts(world.watcherId),
    mergeId,
    childInstanceId,
    identity.epoch
  )
  if (progress === null) {
    return { effect: 'indeterminate' }
  }
  const source = world.mergeSources?.[childInstanceId]
  if (source === undefined) {
    return { effect: 'indeterminate' }
  }
  try {
    await lease.assertHeld()
    const runTarget = await resolveObjectiveWorkspaceTarget(
      shared.dependencies.runtime,
      world.enrollment
    )
    assertRunWorkspace(world, runTarget)
    const childState = runState(world, world.ledger).nodes.get(childInstanceId)
    const childRecord =
      source.workspacePath === null || childState === undefined
        ? null
        : childWorktreeFact(world.facts, childInstanceId, childState.epoch)
    if (
      source.workspacePath !== null &&
      (childRecord === null || childRecord.setupState !== 'ready')
    ) {
      return { effect: 'indeterminate' }
    }
    const childTarget =
      childRecord === null
        ? null
        : await childContext(action, world, shared.dependencies.runtime, childRecord)
    const resolveTarget = async (workspacePath: string): Promise<ObjectiveWorkspaceTarget> => {
      if (workspacePath === runTarget.workspacePath) {
        return runTarget
      }
      if (childTarget !== null && workspacePath === childTarget.workspacePath) {
        return childTarget
      }
      throw new Error('Pipeline Merge source path is not an enrolled or recorded child workspace')
    }
    const current = await readMergeSourceFacts(
      {
        watcherId: world.watcherId,
        mergeId,
        epoch: identity.epoch,
        childInstanceId,
        workspacePath: source.workspacePath,
        runWorkspacePath: runTarget.workspacePath,
        applicableBaseCommit: baseCommit,
        childCommitSha
      },
      { store: shared.dependencies.pipelineStore, resolveTarget }
    )
    if (
      current.workspacePath !== childWorkspacePath ||
      current.sourceHead !== sourceHead ||
      current.committedChildSha !== childCommitSha ||
      current.workspaceDigest !== workspaceDigest ||
      current.applicableBaseCommit !== baseCommit ||
      progress.epoch !== identity.epoch
    ) {
      return { effect: 'indeterminate' }
    }
    if (progress.state === 'applied' && isObjectiveGitObjectId(progress.appliedCommitSha ?? '')) {
      const head = await readHead(runTarget)
      return head === progress.appliedCommitSha ? { effect: 'landed' } : { effect: 'indeterminate' }
    }
    if (progress.state === 'conflict' && progress.conflict !== null) {
      if (attempt.result !== undefined) {
        const resultRecord = record(attempt.result)
        if (
          resultRecord === null ||
          !isDeepStrictEqual(resultRecord.conflictPaths, progress.conflict.paths) ||
          !isDeepStrictEqual(
            resultRecord.conflictingChildren,
            progress.conflict.conflictingChildren
          )
        ) {
          return { effect: 'indeterminate' }
        }
      }
      return { effect: 'not-landed', failureClass: 'criteria' }
    }
  } catch {
    return { effect: 'indeterminate', failureClass: 'infra' }
  }
  return { effect: 'indeterminate' }
}

export function createPipelineMergeActions(shared: PipelineActionDispatchContext): Readonly<{
  execute(
    action: KernelAction,
    world: PipelineReadyWorld,
    identity: Identity,
    context: ExecuteContext<PipelineKindWorld>
  ): Promise<ActionOutcome | null>
  resolveOutcome(
    attempt: AttemptEntry,
    world: PipelineReadyWorld,
    ledger: WatcherLedger,
    identity: Identity,
    lease: LeaseGuard
  ): Promise<EffectCertaintyResolution | null>
  preflight(
    action: KernelAction,
    world: PipelineReadyWorld,
    ledger: WatcherLedger
  ): Promise<string | null>
}> {
  const execute = async (
    action: KernelAction,
    world: PipelineReadyWorld,
    identity: Identity,
    context: ExecuteContext<PipelineKindWorld>
  ): Promise<ActionOutcome | null> => {
    if (action.kind === 'pipeline-merge-child') {
      return await executeMergeChild(action, world, identity, context, shared.dependencies)
    }
    if (action.kind === 'pipeline-resolve-merge-conflict') {
      return await executePipelineConflictResolver(action, world, identity, context, shared)
    }
    return null
  }

  const resolveOutcome = async (
    attempt: AttemptEntry,
    world: PipelineReadyWorld,
    ledger: WatcherLedger,
    identity: Identity,
    lease: LeaseGuard
  ): Promise<EffectCertaintyResolution | null> => {
    if (attempt.action.kind === 'pipeline-merge-child') {
      return await resolveMergeChildOutcome(attempt.action, attempt, world, identity, lease, shared)
    }
    if (attempt.action.kind === 'pipeline-resolve-merge-conflict') {
      return await resolvePipelineConflictResolverOutcome(
        attempt,
        world,
        ledger,
        identity,
        lease,
        shared
      )
    }
    return null
  }

  const preflight = async (
    action: KernelAction,
    world: PipelineReadyWorld,
    ledger: WatcherLedger
  ): Promise<string | null> => {
    if (action.kind === 'pipeline-merge-child') {
      return mergeActionIsFresh(action, world, ledger)
        ? null
        : 'Pipeline Merge source identity changed.'
    }
    if (action.kind !== 'pipeline-resolve-merge-conflict') {
      return null
    }
    const resolver = validatePipelineMergeResolver(action, world, ledger)
    if (resolver === null) {
      return 'Pipeline conflict provenance or integration grant changed.'
    }
    if (resolver.progress.state === 'resolved') {
      return 'Pipeline conflict is already resolved.'
    }
    try {
      const source = await readPipelineMergeResolverSource(
        action,
        world,
        resolver,
        shared.dependencies
      )
      return source === null
        ? 'Pipeline conflict source, base, or worktree authority changed.'
        : null
    } catch {
      return 'Pipeline conflict worktree authority is unavailable.'
    }
  }

  return { execute, resolveOutcome, preflight }
}
