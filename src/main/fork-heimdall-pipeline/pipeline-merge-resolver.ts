import { isDeepStrictEqual } from 'node:util'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import { parsePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import {
  childTaskIdFromInstanceId,
  nodeIdFromInstanceId,
  pipelineNodeIdentity,
  type PipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type {
  PipelineMergeNode,
  PipelineSwarmNode
} from '../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import type { PipelineStore } from './pipeline-store'
import type { PipelineMergeSourceFacts } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import { resolvePipelineChildTarget } from './pipeline-merge-source-reader'
import { readMergeSourceFacts } from './merge-executor'
import { assertRunWorkspace, readHead } from './pipeline-action-dispatch-workspace'
import type { PipelineActionDispatcherDependencies } from './pipeline-action-dispatch-contracts'
import {
  appliedChildren,
  arrayOfStrings,
  childWorktreeFact,
  latestExpansion,
  latestProgressForChild,
  mergeNode,
  originalMergeStep,
  record,
  runState,
  swarmForMerge,
  text,
  optionalText
} from './pipeline-action-identity'

export type PipelineMergeResolverValidation = Readonly<{
  merge: PipelineMergeNode
  swarm: PipelineSwarmNode
  taskId: string
  childInstanceId: string
  progress: PipelineStoreFacts['mergeProgress'][number]
  worktree: PipelineStoreFacts['childWorktrees'][number]
  originalAttempt: AttemptEntry
  childDispatch: PipelineStoreFacts['dispatches'][number]
  conflictPaths: string[]
  expansion: PipelineStoreFacts['swarmExpansions'][number] & { baseCommit: string }
}>

function conflictStep(action: KernelAction): string {
  return JSON.stringify([
    'merge-conflict-resolver',
    action.mergeId,
    action.childInstanceId,
    action.originalMergeStep,
    action.originalMergeEpoch,
    action.originalMergeAttemptId,
    action.originalMergeAttemptFingerprint,
    action.originalChildCommitSha,
    action.sourceHead,
    action.workspaceDigest,
    action.baseCommit,
    action.childCommitSha,
    action.currentSourceHead,
    action.currentWorkspaceDigest,
    action.mergedHead,
    action.childWorkspacePath,
    action.conflictPaths,
    action.conflictingChildren,
    action.appliedChildren,
    action.harness,
    action.model ?? null,
    action.effort ?? null,
    action.workspaceId,
    action.reuseTerminal
  ])
}

function matchingOriginalMergeAttempt(
  action: KernelAction,
  ledger: WatcherLedger,
  progress: PipelineMergeResolverValidation['progress']
): AttemptEntry | null {
  const mergeId = text(action, 'mergeId')
  const childInstanceId = text(action, 'childInstanceId')
  const taskId = text(action, 'taskId')
  const originalMergeStepValue = text(action, 'originalMergeStep')
  const originalAttemptId = text(action, 'originalMergeAttemptId')
  const originalFingerprint = text(action, 'originalMergeAttemptFingerprint')
  const originalMergeEpoch = action.originalMergeEpoch
  const normalizedChildCommitSha = text(action, 'childCommitSha')
  if (
    mergeId === null ||
    childInstanceId === null ||
    taskId === null ||
    originalMergeStepValue === null ||
    originalAttemptId === null ||
    originalFingerprint === null ||
    typeof originalMergeEpoch !== 'number' ||
    !Number.isInteger(originalMergeEpoch) ||
    originalMergeEpoch < 0 ||
    originalMergeEpoch > progress.epoch ||
    !isObjectiveGitObjectId(normalizedChildCommitSha ?? '') ||
    progress.commitSha !== normalizedChildCommitSha
  ) {
    return null
  }

  let selected: AttemptEntry | null = null
  for (const candidate of getLatestAttempts(ledger)) {
    const original = candidate.action
    const identity = pipelineNodeIdentity(original)
    const originalStep = parsePipelineNodeEvidenceKey(original.evidenceKey)?.step
    const result = record(candidate.result)
    const conflictPaths = arrayOfStrings(result?.conflictPaths)
    const conflictingChildren = arrayOfStrings(result?.conflictingChildren)
    if (
      original.kind !== 'pipeline-merge-child' ||
      original.capability !== 'integrate' ||
      original.contentIdentity !== action.contentIdentity ||
      identity?.instanceId !== mergeId ||
      identity.nodeId !== mergeId ||
      identity.epoch !== originalMergeEpoch ||
      candidate.attemptId !== originalAttemptId ||
      candidate.fingerprint !== originalFingerprint ||
      candidate.fingerprint !==
        makeAttemptFingerprint(original.contentIdentity, original.kind, original.evidenceKey) ||
      candidate.state !== 'settled' ||
      candidate.effect !== 'not-landed' ||
      candidate.failureClass !== 'criteria' ||
      candidate.reason !== 'merge-conflict' ||
      candidate.watcherId !== ledger.watcherId ||
      conflictPaths === null ||
      conflictingChildren === null ||
      progress.conflict === null ||
      !isDeepStrictEqual(conflictPaths, progress.conflict.paths) ||
      !isDeepStrictEqual(conflictingChildren, progress.conflict.conflictingChildren) ||
      text(original, 'mergeId') !== mergeId ||
      text(original, 'childInstanceId') !== childInstanceId ||
      text(original, 'taskId') !== taskId ||
      originalStep !== originalMergeStep(original) ||
      originalStep !== originalMergeStepValue ||
      !isObjectiveGitObjectId(text(original, 'sourceHead') ?? '') ||
      !/^[0-9a-f]{64}$/u.test(text(original, 'workspaceDigest') ?? '') ||
      !isObjectiveGitObjectId(text(original, 'baseCommit') ?? '') ||
      (typeof original.childCommitSha === 'string' &&
        !isObjectiveGitObjectId(original.childCommitSha)) ||
      text(original, 'childWorkspacePath') !== text(action, 'childWorkspacePath') ||
      text(original, 'sourceHead') !== text(action, 'sourceHead') ||
      text(original, 'workspaceDigest') !== text(action, 'workspaceDigest') ||
      text(original, 'baseCommit') !== text(action, 'baseCommit') ||
      !isDeepStrictEqual(original.childCommitSha, action.originalChildCommitSha) ||
      !isDeepStrictEqual(appliedChildren(original), appliedChildren(action)) ||
      (selected !== null && selected.atMs >= candidate.atMs)
    ) {
      continue
    }
    selected = candidate
  }
  if (selected === null) {
    return null
  }
  return parsePipelineNodeEvidenceKey(action.evidenceKey)?.step === conflictStep(action)
    ? selected
    : null
}

export function validatePipelineMergeResolver(
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger
): PipelineMergeResolverValidation | null {
  const mergeId = text(action, 'mergeId')
  const childInstanceId = text(action, 'childInstanceId')
  const taskId = text(action, 'taskId')
  const identity = pipelineNodeIdentity(action)
  const conflictPaths = arrayOfStrings(action.conflictPaths)
  const conflictChildren = arrayOfStrings(action.conflictingChildren)
  if (
    action.kind !== 'pipeline-resolve-merge-conflict' ||
    action.capability !== 'agent' ||
    mergeId === null ||
    childInstanceId === null ||
    taskId === null ||
    identity === null ||
    identity.nodeId !== mergeId ||
    identity.instanceId !== `${mergeId}[${taskId}]` ||
    nodeIdFromInstanceId(childInstanceId) === null ||
    childTaskIdFromInstanceId(childInstanceId) !== taskId ||
    conflictPaths === null ||
    conflictPaths.length === 0 ||
    conflictChildren === null ||
    (world.grants.integrate ?? 'off') === 'off' ||
    (world.grants.agent ?? 'off') === 'off'
  ) {
    return null
  }
  const priorChildren = appliedChildren(action)
  if (
    priorChildren === null ||
    new Set(conflictChildren).size !== conflictChildren.length ||
    conflictChildren.some((taskId) => !priorChildren.some((child) => child.taskId === taskId))
  ) {
    return null
  }
  const merge = mergeNode(world, mergeId)
  const swarm = merge === null ? null : swarmForMerge(world, merge)
  if (
    merge === null ||
    swarm === null ||
    swarm.worktree !== 'own' ||
    nodeIdFromInstanceId(childInstanceId) !== swarm.id
  ) {
    return null
  }
  const state = runState(world, ledger).nodes.get(mergeId)
  if (state === undefined || state.epoch !== identity.epoch || state.attempt !== identity.attempt) {
    return null
  }
  const expansion = latestExpansion(
    world.facts,
    swarm.id,
    runState(world, ledger).nodes.get(swarm.id)?.epoch ?? -1
  )
  if (expansion === null || !expansion.tasks.some((task) => task.id === taskId)) {
    return null
  }
  const expansionBaseCommit = expansion.baseCommit
  if (expansionBaseCommit === null) {
    return null
  }
  const validatedExpansion = { ...expansion, baseCommit: expansionBaseCommit }
  const progress = latestProgressForChild(world.facts, mergeId, childInstanceId)
  if (
    progress === null ||
    progress.epoch !== identity.epoch ||
    (progress.state !== 'conflict' &&
      progress.state !== 'resolving' &&
      progress.state !== 'resolved') ||
    progress.commitSha === null ||
    progress.conflict === null ||
    !isDeepStrictEqual(progress.conflict.paths, conflictPaths) ||
    !isDeepStrictEqual(progress.conflict.conflictingChildren, conflictChildren)
  ) {
    return null
  }
  const childState = runState(world, ledger).nodes.get(childInstanceId)
  const worktree =
    childState === undefined
      ? null
      : childWorktreeFact(world.facts, childInstanceId, childState.epoch)
  if (
    childState === undefined ||
    childState.status !== 'done' ||
    worktree === null ||
    worktree.setupState !== 'ready' ||
    text(action, 'workspaceId') !== worktree.worktreeId ||
    text(action, 'childWorkspacePath') === null
  ) {
    return null
  }
  const source = world.mergeSources?.[childInstanceId]
  const normalizedCommitSha = text(action, 'childCommitSha')
  const currentSourceHead = text(action, 'currentSourceHead')
  const currentWorkspaceDigest = text(action, 'currentWorkspaceDigest')
  const mergedHead = text(action, 'mergedHead')
  if (
    source === undefined ||
    normalizedCommitSha === null ||
    !isObjectiveGitObjectId(currentSourceHead ?? '') ||
    !/^[0-9a-f]{64}$/u.test(currentWorkspaceDigest ?? '') ||
    !isObjectiveGitObjectId(mergedHead ?? '') ||
    source.workspacePath !== text(action, 'childWorkspacePath') ||
    source.committedChildSha !== normalizedCommitSha ||
    source.applicableBaseCommit !== mergedHead ||
    !/^[0-9a-f]{64}$/u.test(source.workspaceDigest)
  ) {
    return null
  }
  const sourceMatchesAction =
    source.sourceHead === currentSourceHead && source.workspaceDigest === currentWorkspaceDigest
  if (progress.state === 'conflict' && !sourceMatchesAction) {
    return null
  }
  const originalAttempt = matchingOriginalMergeAttempt(action, ledger, progress)
  if (originalAttempt === null) {
    return null
  }
  let childDispatch: PipelineStoreFacts['dispatches'][number] | undefined
  for (const candidate of world.facts.dispatches) {
    if (
      candidate.instanceId === childInstanceId &&
      candidate.epoch === childState.epoch &&
      candidate.attempt === childState.attempt &&
      (childDispatch === undefined || candidate.dispatchedAtMs > childDispatch.dispatchedAtMs)
    ) {
      childDispatch = candidate
    }
  }
  if (
    childDispatch === undefined ||
    childDispatch.terminalHandle === null ||
    childDispatch.workspaceId !== worktree.worktreeId ||
    text(action, 'reuseTerminal') !== childDispatch.terminalHandle
  ) {
    return null
  }
  const workerAttempt = getLatestAttempts(ledger).find((candidate) => {
    const workerIdentity = pipelineNodeIdentity(candidate.action)
    return (
      candidate.watcherId === world.watcherId &&
      candidate.action.kind === 'pipeline-dispatch-agent' &&
      candidate.action.capability === 'agent' &&
      candidate.action.contentIdentity === action.contentIdentity &&
      workerIdentity?.instanceId === childInstanceId &&
      workerIdentity.nodeId === swarm.id &&
      workerIdentity.epoch === childState.epoch &&
      workerIdentity.attempt === childState.attempt &&
      candidate.fingerprint ===
        makeAttemptFingerprint(
          candidate.action.contentIdentity,
          candidate.action.kind,
          candidate.action.evidenceKey
        ) &&
      candidate.state === 'settled' &&
      candidate.effect === 'landed' &&
      candidate.dispatchId === childDispatch?.dispatchId
    )
  })
  const workerAction = workerAttempt?.action
  const expectedModel = swarm.child.model ?? world.payload.document.defaults?.model
  const expectedEffort = swarm.child.effort ?? world.payload.document.defaults?.effort
  if (
    workerAttempt === undefined ||
    workerAction === undefined ||
    text(workerAction, 'agent') !== swarm.child.harness ||
    optionalText(workerAction, 'model') !== expectedModel ||
    optionalText(workerAction, 'effort') !== expectedEffort ||
    text(action, 'harness') !== text(workerAction, 'agent') ||
    optionalText(action, 'model') !== optionalText(workerAction, 'model') ||
    optionalText(action, 'effort') !== optionalText(workerAction, 'effort')
  ) {
    return null
  }
  return {
    merge,
    swarm,
    taskId,
    childInstanceId,
    progress,
    worktree,
    originalAttempt,
    childDispatch,
    conflictPaths,
    expansion: validatedExpansion
  }
}
export type PipelineMergeResolverSource = Readonly<{
  runTarget: ObjectiveWorkspaceTarget
  childTarget: ObjectiveWorkspaceTarget
  source: PipelineMergeSourceFacts
}>

export async function readPipelineMergeResolverSource(
  action: KernelAction,
  world: PipelineReadyWorld,
  resolver: PipelineMergeResolverValidation,
  dependencies: PipelineActionDispatcherDependencies
): Promise<PipelineMergeResolverSource | null> {
  const mergedHead = text(action, 'mergedHead')
  const childCommitSha = text(action, 'childCommitSha')
  if (mergedHead === null || childCommitSha === null || !isObjectiveGitObjectId(mergedHead)) {
    return null
  }
  const runTarget = await resolveObjectiveWorkspaceTarget(dependencies.runtime, world.enrollment)
  assertRunWorkspace(world, runTarget)
  if ((await readHead(runTarget)) !== mergedHead) {
    return null
  }
  const childTarget = await resolvePipelineChildTarget({
    runtime: dependencies.runtime,
    enrollment: world.enrollment,
    instanceId: resolver.childInstanceId,
    epoch: resolver.worktree.epoch,
    worktreeId: resolver.worktree.worktreeId
  })
  if (childTarget.workspacePath !== text(action, 'childWorkspacePath')) {
    return null
  }
  const source = await readMergeSourceFacts(
    {
      watcherId: world.watcherId,
      mergeId: resolver.merge.id,
      epoch: resolver.progress.epoch,
      childInstanceId: resolver.childInstanceId,
      workspacePath: childTarget.workspacePath,
      runWorkspacePath: runTarget.workspacePath,
      applicableBaseCommit: mergedHead,
      childCommitSha
    },
    {
      store: dependencies.pipelineStore,
      resolveTarget: async (workspacePath) => {
        if (workspacePath !== childTarget.workspacePath) {
          throw new Error('Pipeline resolver target changed')
        }
        return childTarget
      }
    }
  )
  const expected = world.mergeSources?.[resolver.childInstanceId]
  if (
    expected === undefined ||
    source.childInstanceId !== resolver.childInstanceId ||
    source.workspacePath !== expected.workspacePath ||
    source.sourceHead !== expected.sourceHead ||
    source.committedChildSha !== childCommitSha ||
    source.committedChildSha !== expected.committedChildSha ||
    source.workspaceDigest !== expected.workspaceDigest ||
    source.applicableBaseCommit !== mergedHead ||
    source.applicableBaseCommit !== expected.applicableBaseCommit ||
    !isObjectiveGitObjectId(source.sourceHead) ||
    !/^[0-9a-f]{64}$/u.test(source.workspaceDigest) ||
    source.sourceHead !== text(action, 'currentSourceHead') ||
    source.workspaceDigest !== text(action, 'currentWorkspaceDigest')
  ) {
    return null
  }
  return { runTarget, childTarget, source }
}

export function conflictResolverPrompt(
  action: KernelAction,
  resolver: PipelineMergeResolverValidation
): string {
  const task = resolver.expansion.tasks.find((candidate) => candidate.id === resolver.taskId)
  const paths = resolver.conflictPaths.map((path) => `- ${path}`).join('\n')
  const applied = appliedChildren(action) ?? []
  const prior =
    applied.length === 0
      ? '- none'
      : applied.map((child) => `- ${child.taskId}: ${child.commitSha}`).join('\n')
  return [
    `Resolve Merge node ${resolver.merge.id} conflict for Swarm task ${resolver.taskId}.`,
    `Task: ${task?.title ?? resolver.taskId}`,
    task?.spec ?? '',
    '',
    'Conflicting paths:',
    paths,
    '',
    'Previously applied children:',
    prior,
    '',
    'Resolve the current Git conflicts in this marked child worktree. Do not alter `.orca/pipelines`.',
    'Only report `resolved: true` when all listed conflicts are resolved and the Git index contains no unmerged paths.'
  ]
    .filter(Boolean)
    .join('\n')
}

export function resolverOutputIsStrictlyTrue(
  store: PipelineStore,
  attempt: AttemptEntry,
  identity: PipelineNodeIdentity
): boolean {
  const output = store
    .facts(attempt.watcherId)
    .outputs.find(
      (candidate) =>
        candidate.instanceId === identity.instanceId &&
        candidate.epoch === identity.epoch &&
        candidate.attempt === identity.attempt
    )
  return (
    output !== undefined &&
    Object.keys(output.outputs).length === 1 &&
    output.outputs.resolved === true
  )
}
