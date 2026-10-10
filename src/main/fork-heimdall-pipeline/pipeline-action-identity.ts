import { isDeepStrictEqual } from 'node:util'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  pipelineNodeIdentity,
  type PipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { parsePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import { derivePipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineMergeSourceFacts } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type {
  PipelineAgentNode,
  PipelineMergeNode,
  PipelineSwarmNode
} from '../../shared/fork-heimdall-pipeline/document-schema'
import type { MergeAppliedChild } from './merge-executor'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'
import { isPipelineInvalidConfigurationWorld } from './pipeline-kind-read'

export type Identity = PipelineNodeIdentity
export type ChildWorktreeFact = PipelineStoreFacts['childWorktrees'][number]
export type MergeProgressFact = PipelineStoreFacts['mergeProgress'][number]

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function text(action: KernelAction, key: string): string | null {
  const value = action[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function optionalText(action: KernelAction, key: string): string | undefined {
  const value = action[key]
  return typeof value === 'string' ? value : undefined
}

export function isPipelineRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> | null {
  return isPipelineRecord(value) ? value : null
}

export function arrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null
}

export function appliedChildren(action: KernelAction): MergeAppliedChild[] | null {
  const value = action.appliedChildren
  if (!Array.isArray(value)) {
    return null
  }
  const result: MergeAppliedChild[] = []
  for (const row of value) {
    const child = record(row)
    if (child === null || typeof child.taskId !== 'string' || typeof child.commitSha !== 'string') {
      return null
    }
    result.push({ taskId: child.taskId, commitSha: child.commitSha })
  }
  return result
}

function readyWorld(world: PipelineKindWorld): PipelineReadyWorld | null {
  return isPipelineInvalidConfigurationWorld(world) ? null : world
}

export function cacheWorld(
  snapshot: Snapshot<PipelineKindWorld>,
  worlds: Map<string, PipelineReadyWorld>
): PipelineReadyWorld | null {
  const world = readyWorld(snapshot.world)
  if (world !== null) {
    worlds.set(world.watcherId, world)
  }
  return world
}

export function runState(world: PipelineReadyWorld, ledger: WatcherLedger) {
  return derivePipelineRunState({
    payload: world.payload,
    ledger,
    facts: world.facts,
    nowMs: world.nowMs,
    hasOwner: world.hasOwner,
    unverifiableDispatchIds: world.unverifiableDispatchIds,
    composites: world.composites
  })
}

export function currentIdentityMatches(
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger
): Identity | null {
  const identity = pipelineNodeIdentity(action)
  const decoded = parsePipelineNodeEvidenceKey(action.evidenceKey)
  if (
    identity === null ||
    decoded === null ||
    decoded.instanceId !== identity.instanceId ||
    decoded.epoch !== identity.epoch ||
    decoded.attempt !== identity.attempt ||
    action.contentIdentity !== `pipeline:${world.payload.pin.contentHash}`
  ) {
    return null
  }
  const stateKey =
    action.kind === 'pipeline-resolve-merge-conflict' ? identity.nodeId : identity.instanceId
  const state = runState(world, ledger).nodes.get(stateKey)
  return state !== undefined && state.epoch === identity.epoch && state.attempt === identity.attempt
    ? identity
    : null
}

export function attemptIsCurrent(
  attempt: AttemptEntry,
  world: PipelineReadyWorld,
  ledger: WatcherLedger
): Identity | null {
  const action = attempt.action
  const latest = getLatestAttempts(ledger).find(
    (candidate) => candidate.attemptId === attempt.attemptId
  )
  if (
    attempt.watcherId !== world.watcherId ||
    latest === undefined ||
    latest.fingerprint !== attempt.fingerprint ||
    !isDeepStrictEqual(latest.action, action) ||
    attempt.fingerprint !==
      makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey)
  ) {
    return null
  }
  return currentIdentityMatches(action, world, ledger)
}

export function nodeConfig(
  world: PipelineReadyWorld,
  identity: Identity
): PipelineAgentNode | null {
  const node = world.payload.document.nodes.find((candidate) => candidate.id === identity.nodeId)
  if (node?.type === 'agent') {
    return node
  }
  if (node?.type === 'swarm') {
    return { ...node.child, id: node.id, type: 'agent' }
  }
  return null
}

export function childWorktreeFact(
  facts: PipelineStoreFacts,
  instanceId: string,
  epoch: number
): ChildWorktreeFact | null {
  let selected: ChildWorktreeFact | null = null
  for (const candidate of facts.childWorktrees) {
    if (candidate.instanceId === instanceId && candidate.epoch === epoch) {
      selected = candidate
    }
  }
  return selected
}

export function latestExpansion(
  facts: PipelineStoreFacts,
  swarmId: string,
  epoch: number
): PipelineStoreFacts['swarmExpansions'][number] | null {
  let selected: PipelineStoreFacts['swarmExpansions'][number] | null = null
  for (const candidate of facts.swarmExpansions) {
    if (candidate.swarmId === swarmId && candidate.epoch === epoch) {
      selected = candidate
    }
  }
  return selected
}

export function latestProgress(
  facts: PipelineStoreFacts,
  mergeId: string,
  childInstanceId: string,
  epoch: number
): MergeProgressFact | null {
  let selected: MergeProgressFact | null = null
  for (const candidate of facts.mergeProgress) {
    if (
      candidate.mergeId === mergeId &&
      candidate.childInstanceId === childInstanceId &&
      candidate.epoch === epoch
    ) {
      selected = candidate
    }
  }
  return selected
}

export function latestProgressForChild(
  facts: PipelineStoreFacts,
  mergeId: string,
  childInstanceId: string
): MergeProgressFact | null {
  let selected: MergeProgressFact | null = null
  for (const candidate of facts.mergeProgress) {
    if (
      candidate.mergeId === mergeId &&
      candidate.childInstanceId === childInstanceId &&
      (selected === null || candidate.epoch >= selected.epoch)
    ) {
      selected = candidate
    }
  }
  return selected
}

export function mergeNode(world: PipelineReadyWorld, mergeId: string): PipelineMergeNode | null {
  const node = world.payload.document.nodes.find((candidate) => candidate.id === mergeId)
  return node?.type === 'merge' ? node : null
}

export function swarmForMerge(
  world: PipelineReadyWorld,
  merge: PipelineMergeNode
): PipelineSwarmNode | null {
  const node = world.payload.document.nodes.find(
    (candidate) => candidate.type === 'swarm' && candidate.id === merge.from
  )
  return node?.type === 'swarm' ? node : null
}

export function expectedMergeStep(source: PipelineMergeSourceFacts): string {
  const identity =
    source.committedChildSha === null
      ? ['worktree', source.sourceHead, source.workspaceDigest]
      : ['commit', source.committedChildSha]
  return JSON.stringify([source.childInstanceId, identity, source.applicableBaseCommit])
}

export function originalMergeStep(action: KernelAction): string | null {
  const instanceId = text(action, 'childInstanceId')
  const sourceHead = text(action, 'sourceHead')
  const workspaceDigest = text(action, 'workspaceDigest')
  const baseCommit = text(action, 'baseCommit')
  const commitSha = action.childCommitSha
  if (
    instanceId === null ||
    sourceHead === null ||
    workspaceDigest === null ||
    baseCommit === null ||
    (typeof commitSha !== 'string' && commitSha !== null)
  ) {
    return null
  }
  const sourceIdentity =
    commitSha === null ? ['worktree', sourceHead, workspaceDigest] : ['commit', commitSha]
  return JSON.stringify([instanceId, sourceIdentity, baseCommit])
}

export function sourceMatchesMergeAction(
  action: KernelAction,
  world: PipelineReadyWorld,
  source: PipelineMergeSourceFacts | undefined
): source is PipelineMergeSourceFacts {
  const childInstanceId = text(action, 'childInstanceId')
  const baseCommit = text(action, 'baseCommit')
  const sourceHead = text(action, 'sourceHead')
  const workspaceDigest = text(action, 'workspaceDigest')
  const childCommitSha = action.childCommitSha
  const workspacePath = action.childWorkspacePath
  const paths = arrayOfStrings(action.unmergedPaths)
  const applied = appliedChildren(action)
  if (
    childInstanceId === null ||
    baseCommit === null ||
    sourceHead === null ||
    workspaceDigest === null ||
    (typeof childCommitSha !== 'string' && childCommitSha !== null) ||
    (typeof workspacePath !== 'string' && workspacePath !== null) ||
    paths === null ||
    applied === null ||
    source === undefined ||
    pipelineNodeIdentity(action)?.nodeId !== text(action, 'mergeId') ||
    source.childInstanceId !== childInstanceId ||
    source.workspacePath !== workspacePath ||
    source.sourceHead !== sourceHead ||
    source.committedChildSha !== childCommitSha ||
    source.workspaceDigest !== workspaceDigest ||
    source.applicableBaseCommit !== baseCommit ||
    source.unmergedPaths.length > 0 ||
    paths.length > 0 ||
    parsePipelineNodeEvidenceKey(action.evidenceKey)?.step !== expectedMergeStep(source) ||
    world.grants.integrate === 'off'
  ) {
    return false
  }
  return true
}
