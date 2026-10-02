import { win32 } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import {
  objectiveGitCommandForTarget,
  parseObjectiveDirtyPaths,
  type ObjectiveWorkspaceTarget
} from '../fork-heimdall-objective/content-identity'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  DispatchResult,
  DispatchWorkerRequest,
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import { runWithGitWorktreeOperationLock } from '../../shared/git-worktree-operation-lock'
import { resolvePipelineChildTarget } from './pipeline-merge-source-reader'
import { readMergeSourceFacts } from './merge-executor'
import {
  prepareConflictResolution,
  readUnmergedPaths,
  verifyConflictResolved
} from './pipeline-merge-git'
import type { PipelineAgentNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineReadyWorld, PipelineKindWorld } from './pipeline-kind-read'
import type { PipelineActionDispatchContext } from './pipeline-action-dispatch-contracts'
import { dispatchAgentNode, resolveAgentAttempt } from './agent-node-executor'
import { type Identity, text } from './pipeline-action-identity'
import { composeTarget } from './pipeline-action-dispatch-workspace'
import {
  conflictResolverPrompt,
  readPipelineMergeResolverSource,
  resolverOutputIsStrictlyTrue,
  validatePipelineMergeResolver
} from './pipeline-merge-resolver'

/** Matches Git's redundant clean cherry-pick using its exact parent, tree, author, and message. */
async function hasCleanlyPreparedConflictCommit(
  target: ObjectiveWorkspaceTarget,
  sourceHead: string,
  mergedHead: string,
  childCommitSha: string
): Promise<boolean> {
  const runGit = objectiveGitCommandForTarget(target)
  const [prepared, source, mergedTree, status, unmergedPaths] = await Promise.all([
    runGit(['show', '-s', '--format=%H%x00%P%x00%T%x00%an%x00%ae%x00%aI%x00%B', 'HEAD']),
    runGit(['show', '-s', '--format=%H%x00%P%x00%T%x00%an%x00%ae%x00%aI%x00%B', childCommitSha]),
    runGit(['rev-parse', '--verify', `${mergedHead}^{tree}`]),
    runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--']),
    readUnmergedPaths(runGit)
  ])
  const dirtyPaths = parseObjectiveDirtyPaths(
    status.stdout,
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  ).entries
  const preparedFields = prepared.stdout.split('\0')
  const sourceFields = source.stdout.split('\0')
  const parents = preparedFields[1]?.split(' ') ?? []
  return (
    dirtyPaths.length === 0 &&
    unmergedPaths.length === 0 &&
    preparedFields[0] === sourceHead &&
    parents.length === 1 &&
    parents[0] === mergedHead &&
    preparedFields[2] === mergedTree.stdout.trim() &&
    sourceFields[2] === mergedTree.stdout.trim() &&
    preparedFields.slice(2).join('\0') === sourceFields.slice(2).join('\0') &&
    sourceFields[0] === childCommitSha &&
    isObjectiveGitObjectId(sourceHead)
  )
}

export async function executePipelineConflictResolver(
  action: KernelAction,
  world: PipelineReadyWorld,
  identity: Identity,
  context: ExecuteContext<PipelineKindWorld>,
  shared: PipelineActionDispatchContext
): Promise<ActionOutcome> {
  const resolver = validatePipelineMergeResolver(action, world, context.ledger)
  if (resolver === null) {
    return {
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: 'pipeline-conflict-provenance-stale'
    }
  }
  if (resolver.progress.state === 'resolved') {
    return {
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: 'pipeline-conflict-already-resolved'
    }
  }
  const harness = text(action, 'harness')
  const reuseTerminal = text(action, 'reuseTerminal')
  if (harness === null || reuseTerminal === null) {
    return {
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: 'pipeline-conflict-dispatch-stale'
    }
  }
  try {
    const current = await readPipelineMergeResolverSource(
      action,
      world,
      resolver,
      shared.dependencies
    )
    if (current === null) {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'pipeline-conflict-source-stale'
      }
    }
    await context.lease.assertHeld()
    if (resolver.progress.state === 'conflict') {
      shared.dependencies.pipelineStore.setMergeProgress({
        watcherId: world.watcherId,
        mergeId: resolver.merge.id,
        epoch: resolver.progress.epoch,
        childInstanceId: resolver.childInstanceId,
        state: 'resolving',
        commitSha: resolver.progress.commitSha,
        conflict: resolver.progress.conflict
      })
    }
    await context.lease.assertHeld()
    const mergedHead = text(action, 'mergedHead')
    const childCommitSha = text(action, 'childCommitSha')
    if (mergedHead === null || childCommitSha === null) {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'pipeline-conflict-source-invalid'
      }
    }
    const alreadyPrepared = await runWithGitWorktreeOperationLock(
      current.childTarget.workspacePath,
      undefined,
      async () => {
        await context.lease.assertHeld()
        if (
          !(await hasCleanlyPreparedConflictCommit(
            current.childTarget,
            current.source.sourceHead,
            mergedHead,
            childCommitSha
          ))
        ) {
          return false
        }
        await context.lease.assertHeld()
        shared.dependencies.pipelineStore.setMergeProgress({
          watcherId: world.watcherId,
          mergeId: resolver.merge.id,
          epoch: resolver.progress.epoch,
          childInstanceId: resolver.childInstanceId,
          state: 'resolved',
          commitSha: resolver.progress.commitSha,
          conflict: null
        })
        return true
      }
    )
    if (alreadyPrepared) {
      return { effect: 'landed' }
    }
    const prepared = await prepareConflictResolution(
      {
        childWorkspacePath: current.childTarget.workspacePath,
        mergedHead,
        childCommitSha
      },
      {
        lease: context.lease,
        resolveTarget: async (workspacePath) => {
          if (workspacePath !== current.childTarget.workspacePath) {
            throw new Error('Pipeline resolver target changed')
          }
          return current.childTarget
        }
      }
    )
    if (prepared.status === 'applied-cleanly') {
      await context.lease.assertHeld()
      shared.dependencies.pipelineStore.setMergeProgress({
        watcherId: world.watcherId,
        mergeId: resolver.merge.id,
        epoch: resolver.progress.epoch,
        childInstanceId: resolver.childInstanceId,
        state: 'resolved',
        commitSha: resolver.progress.commitSha,
        conflict: null
      })
      return { effect: 'landed', result: { detail: 'conflict-applied-cleanly' } }
    }
    const preparedSource = await readMergeSourceFacts(
      {
        watcherId: world.watcherId,
        mergeId: resolver.merge.id,
        epoch: resolver.progress.epoch,
        childInstanceId: resolver.childInstanceId,
        workspacePath: current.childTarget.workspacePath,
        runWorkspacePath: current.runTarget.workspacePath,
        applicableBaseCommit: mergedHead,
        childCommitSha
      },
      {
        store: shared.dependencies.pipelineStore,
        resolveTarget: async (workspacePath) => {
          if (workspacePath !== current.childTarget.workspacePath) {
            throw new Error('Pipeline resolver target changed')
          }
          return current.childTarget
        }
      }
    )
    if (
      preparedSource.workspacePath !== current.childTarget.workspacePath ||
      preparedSource.sourceHead !== mergedHead ||
      preparedSource.committedChildSha !== childCommitSha ||
      preparedSource.applicableBaseCommit !== mergedHead ||
      !/^[0-9a-f]{64}$/u.test(preparedSource.workspaceDigest) ||
      !isDeepStrictEqual(preparedSource.unmergedPaths, resolver.conflictPaths)
    ) {
      return {
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'pipeline-conflict-proof-missing'
      }
    }
    const pipelineTarget = await composeTarget(current.childTarget, resolver.worktree.worktreeId)
    const node: PipelineAgentNode = {
      id: resolver.merge.id,
      type: 'agent',
      prompt: 'Resolve this pipeline Merge conflict.',
      outputs: { resolved: { type: 'boolean' } }
    }
    await context.lease.assertHeld()
    return await dispatchAgentNode(
      {
        watcherId: world.watcherId,
        node,
        instanceId: identity.instanceId,
        epoch: identity.epoch,
        attempt: identity.attempt,
        attemptFingerprint: makeAttemptFingerprint(
          action.contentIdentity,
          action.kind,
          action.evidenceKey
        ),
        renderedPrompt: conflictResolverPrompt(action, resolver),
        harness,
        ...(typeof action.model === 'string' ? { model: action.model } : {}),
        ...(typeof action.effort === 'string' ? { effort: action.effort } : {}),
        target: pipelineTarget
      },
      {
        store: shared.dependencies.pipelineStore,
        nowMs: shared.dependencies.nowMs,
        dispatchWorker: (request: DispatchWorkerRequest): Promise<DispatchResult> =>
          context.dispatchWorker({ ...request, reuseTerminal })
      }
    )
  } catch (error) {
    return {
      effect: 'indeterminate',
      failureClass: 'infra',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function resolvePipelineConflictResolverOutcome(
  attempt: AttemptEntry,
  world: PipelineReadyWorld,
  ledger: WatcherLedger,
  identity: Identity,
  lease: LeaseGuard,
  shared: PipelineActionDispatchContext
): Promise<EffectCertaintyResolution> {
  const action = attempt.action
  const resolver = validatePipelineMergeResolver(action, world, ledger)
  if (resolver === null) {
    return { effect: 'indeterminate' }
  }
  const agentResult = await resolveAgentAttempt(attempt, {
    store: shared.dependencies.pipelineStore,
    resolveReportContext: shared.resolveReportContext,
    nowMs: shared.dependencies.nowMs
  })
  if (agentResult.effect !== 'landed') {
    return agentResult
  }
  if (!resolverOutputIsStrictlyTrue(shared.dependencies.pipelineStore, attempt, identity)) {
    return { effect: 'not-landed', failureClass: 'criteria' }
  }
  try {
    await lease.assertHeld()
    const target = await resolvePipelineChildTarget({
      runtime: shared.dependencies.runtime,
      enrollment: world.enrollment,
      instanceId: resolver.childInstanceId,
      epoch: resolver.worktree.epoch,
      worktreeId: resolver.worktree.worktreeId
    })
    if (target.workspacePath !== text(action, 'childWorkspacePath')) {
      return { effect: 'indeterminate' }
    }
    const clear = await verifyConflictResolved(
      {
        childWorkspacePath: target.workspacePath,
        conflictPaths: resolver.conflictPaths
      },
      {
        resolveTarget: async (workspacePath) => {
          if (workspacePath !== target.workspacePath) {
            throw new Error('Pipeline resolver target changed')
          }
          return target
        }
      }
    )
    if (!clear) {
      return { effect: 'not-landed', failureClass: 'criteria' }
    }
    await lease.assertHeld()
    shared.dependencies.pipelineStore.setMergeProgress({
      watcherId: world.watcherId,
      mergeId: resolver.merge.id,
      epoch: resolver.progress.epoch,
      childInstanceId: resolver.childInstanceId,
      state: 'resolved',
      commitSha: resolver.progress.commitSha,
      conflict: null
    })
    return { effect: 'landed' }
  } catch {
    return { effect: 'indeterminate' }
  }
}
