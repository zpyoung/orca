import type { KindConcurrencyPolicy, KernelAction } from '../../shared/fork-heimdall/kind-contract'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import {
  childTaskIdFromInstanceId,
  nodeIdFromInstanceId,
  pipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { landedChoiceAttempts } from '../../shared/fork-heimdall-pipeline/interpreter/node-history'
import type { PipelineKindWorld } from './pipeline-kind-read'
import { isPipelineInvalidConfigurationWorld } from './pipeline-kind-read'
import type { PipelineStore } from './pipeline-store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { cleanupChildWorktrees } from './swarm-executor'

export type PipelineConcurrencyPolicy = KindConcurrencyPolicy<PipelineKindWorld, KernelAction>

export type PipelineConcurrencyDependencies = Readonly<{
  runtime: OrcaRuntimeService
  pipelineStore: PipelineStore
}>

function childInstanceForAction(action: KernelAction): string | null {
  if (action.kind === 'pipeline-resolve-merge-conflict') {
    const childInstanceId = action.childInstanceId
    return typeof childInstanceId === 'string' &&
      childTaskIdFromInstanceId(childInstanceId) !== null
      ? childInstanceId
      : null
  }
  if (action.kind === 'pipeline-dispatch-agent') {
    const instanceId = pipelineNodeIdentity(action)?.instanceId ?? null
    return instanceId !== null && childTaskIdFromInstanceId(instanceId) !== null ? instanceId : null
  }
  return null
}

function isOwnWorktreeChild(action: KernelAction, world: PipelineKindWorld): boolean {
  if (isPipelineInvalidConfigurationWorld(world)) {
    return false
  }
  const instanceId = childInstanceForAction(action)
  if (instanceId === null) {
    return false
  }
  const swarmId = nodeIdFromInstanceId(instanceId)
  const swarm = world.payload.document.nodes.find(
    (node) => node.type === 'swarm' && node.id === swarmId
  )
  return swarm?.type === 'swarm' && swarm.worktree === 'own'
}

function isAgentWorkspaceWriter(action: KernelAction): boolean {
  return (
    action.kind === 'pipeline-dispatch-agent' || action.kind === 'pipeline-resolve-merge-conflict'
  )
}

function isExclusiveRunWorkspaceMutation(action: KernelAction): boolean {
  return (
    action.kind === 'pipeline-merge-child' ||
    action.kind === 'pipeline-land-commit' ||
    action.kind === 'pipeline-land-push' ||
    action.kind === 'pipeline-land-open-review' ||
    action.kind === 'pipeline-run-check' ||
    action.kind === 'pipeline-run-script'
  )
}

function hasSameInstance(action: KernelAction, activeActions: readonly KernelAction[]): boolean {
  const instanceId = pipelineNodeIdentity(action)?.instanceId ?? null
  return (
    instanceId !== null &&
    activeActions.some((active) => pipelineNodeIdentity(active)?.instanceId === instanceId)
  )
}

function latestMergeState(
  facts: PipelineStoreFacts,
  mergeId: string,
  childInstanceId: string
): 'applied' | 'skipped' | null {
  let latestEpoch = -1
  let latestState: 'applied' | 'skipped' | null = null
  for (const progress of facts.mergeProgress) {
    if (
      progress.mergeId === mergeId &&
      progress.childInstanceId === childInstanceId &&
      progress.epoch >= latestEpoch
    ) {
      latestEpoch = progress.epoch
      latestState =
        progress.state === 'applied' || progress.state === 'skipped' ? progress.state : null
    }
  }
  return latestState
}

function hasPersistedReadyChildWorktree(
  attempt: AttemptEntry,
  pipelineStore: PipelineStore
): boolean {
  const action = attempt.action
  const identity = pipelineNodeIdentity(action)
  if (identity === null) {
    return false
  }
  let childInstanceId: string
  let childEpoch: number | null
  if (action.kind === 'pipeline-dispatch-agent') {
    if (childTaskIdFromInstanceId(identity.instanceId) === null) {
      return false
    }
    childInstanceId = identity.instanceId
    childEpoch = identity.epoch
  } else if (action.kind === 'pipeline-resolve-merge-conflict') {
    if (
      typeof action.childInstanceId !== 'string' ||
      childTaskIdFromInstanceId(action.childInstanceId) === null ||
      childTaskIdFromInstanceId(identity.instanceId) !==
        childTaskIdFromInstanceId(action.childInstanceId)
    ) {
      return false
    }
    childInstanceId = action.childInstanceId
    childEpoch = null
  } else {
    return false
  }

  const facts = pipelineStore.facts(attempt.watcherId)
  let latest: PipelineStoreFacts['childWorktrees'][number] | undefined
  for (const worktree of facts.childWorktrees) {
    if (
      worktree.instanceId !== childInstanceId ||
      (childEpoch !== null && worktree.epoch !== childEpoch) ||
      (childEpoch === null && latest !== undefined && worktree.epoch < latest.epoch)
    ) {
      continue
    }
    latest = worktree
  }
  return latest?.setupState === 'ready'
}

function retainSwarmChildWorker(
  attempt: AttemptEntry,
  ledger: WatcherLedger,
  pipelineStore: PipelineStore
): boolean {
  const instanceId = childInstanceForAction(attempt.action)
  if (instanceId === null) {
    return false
  }
  const watcherId = attempt.watcherId
  const pipelineFacts = pipelineStore.facts(watcherId)

  const mergeIds = new Set<string>()
  for (const progress of pipelineFacts.mergeProgress) {
    if (progress.childInstanceId === instanceId) {
      mergeIds.add(progress.mergeId)
    }
  }
  for (const entry of getLatestAttempts(ledger)) {
    if (
      entry.watcherId === watcherId &&
      entry.action.kind === 'pipeline-merge-child' &&
      typeof entry.action.mergeId === 'string' &&
      entry.action.childInstanceId === instanceId
    ) {
      mergeIds.add(entry.action.mergeId)
    }
  }

  const skippedMergeIds = new Set<string>()
  for (const landed of landedChoiceAttempts(ledger)) {
    const action = landed.fact.entry.action
    if (
      landed.fact.entry.watcherId === watcherId &&
      action.kind === 'pipeline-apply-choice' &&
      action.cause === 'merge-conflict' &&
      landed.choice === 'skip' &&
      action.conflictingChildInstanceId === instanceId
    ) {
      const mergeId = landed.fact.identity.nodeId
      mergeIds.add(mergeId)
      skippedMergeIds.add(mergeId)
    }
  }
  if (mergeIds.size === 0) {
    return true
  }
  return [...mergeIds].some(
    (mergeId) =>
      !skippedMergeIds.has(mergeId) && latestMergeState(pipelineFacts, mergeId, instanceId) === null
  )
}

/** Enforces shared-run-worktree serialization while allowing independent isolated children. */
export function createPipelineConcurrencyPolicy(
  dependencies: PipelineConcurrencyDependencies
): PipelineConcurrencyPolicy {
  return {
    canRunAlongside(action, activeActions, snapshot) {
      const world = snapshot.world
      if (isPipelineInvalidConfigurationWorld(world) || hasSameInstance(action, activeActions)) {
        return false
      }
      if (isOwnWorktreeChild(action, world)) {
        return true
      }
      const activeShared = activeActions.filter((active) => !isOwnWorktreeChild(active, world))
      if (isExclusiveRunWorkspaceMutation(action)) {
        return !activeShared.some(
          (active) => isExclusiveRunWorkspaceMutation(active) || isAgentWorkspaceWriter(active)
        )
      }
      if (isAgentWorkspaceWriter(action)) {
        return !activeShared.some(isExclusiveRunWorkspaceMutation)
      }
      return true
    },
    shouldDrainBudget() {
      return false
    },
    preserveAttemptOnContentChange(attempt, snapshot, _ledger) {
      return isOwnWorktreeChild(attempt.action, snapshot.world)
    },
    canRunWhenBudgetExhausted() {
      return false
    },
    isIsolatedAttempt(attempt, _ledger) {
      return hasPersistedReadyChildWorktree(attempt, dependencies.pipelineStore)
    },
    retainWorker(attempt, ledger) {
      return retainSwarmChildWorker(attempt, ledger, dependencies.pipelineStore)
    },
    async reconcile(snapshot, ledger, context) {
      await context.lease.assertHeld()
      const recordedAttemptKeys = new Set<string>()
      for (const attempt of getLatestAttempts(ledger)) {
        recordedAttemptKeys.add(attempt.fingerprint)
        const identity = pipelineNodeIdentity(attempt.action)
        if (identity !== null) {
          recordedAttemptKeys.add(`${identity.instanceId}:${identity.epoch}:${identity.attempt}`)
        }
      }
      dependencies.pipelineStore.reconcile(context.enrollment.watcherId, recordedAttemptKeys)
      await context.lease.assertHeld()
      void snapshot
    },
    async cleanupWorkspaces(_ledger, context) {
      const watcherId = context.enrollment.watcherId
      await context.lease.assertHeld()
      const before = dependencies.pipelineStore.facts(watcherId)
      try {
        await cleanupChildWorktrees(
          {
            watcherId,
            terminal: context.enrollment.terminalAtMs !== null
          },
          { runtime: dependencies.runtime, store: dependencies.pipelineStore }
        )
      } finally {
        await context.lease.assertHeld()
      }
      const after = dependencies.pipelineStore.facts(watcherId)
      const removedChildren = new Set(
        after.childWorktrees
          .filter((worktree) => worktree.setupState === 'removed')
          .map((worktree) => `${worktree.instanceId}:${worktree.epoch}`)
      )
      return before.childWorktrees.some(
        (worktree) =>
          worktree.setupState !== 'removed' &&
          removedChildren.has(`${worktree.instanceId}:${worktree.epoch}`)
      )
    }
  }
}
