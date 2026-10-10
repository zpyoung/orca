import { win32 } from 'node:path'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import type { PipelineMergeSourceFacts } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import { runWithGitWorktreeOperationLock } from '../../shared/git-worktree-operation-lock'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import {
  computeGitRepositoryIdentity,
  isObjectiveMetadataPath,
  objectiveGitCommandForTarget,
  type ObjectiveWorkspaceTarget
} from '../fork-heimdall-objective/content-identity'
import {
  applyObjectiveNodeCommit,
  createObjectiveNodeCommit,
  recoverObjectiveNodeApply
} from '../fork-heimdall-objective/merge-train-git'
import type { PipelineStore } from './pipeline-store'
import { readHead, readUnmergedPaths, resolveGitTarget } from './pipeline-merge-git'

export type MergeAppliedChild = { taskId: string; commitSha: string }

export type MergeChildInput = {
  watcherId: string
  mergeId: string
  epoch: number
  child: { instanceId: string; taskId: string; workspacePath: string | null }
  runWorkspacePath: string
  baseCommit: string
  childCommitSha: string | null
  sourceHead: string
  workspaceDigest: string
  appliedChildren: MergeAppliedChild[]
}

export type MergeChildResult =
  | { status: 'applied'; appliedCommitSha: string }
  | { status: 'conflict'; conflictPaths: string[]; conflictingChildren: string[] }

export type MergeExecutorDeps = {
  store: PipelineStore
  lease: LeaseGuard
  resolveTarget(workspacePath: string): Promise<ObjectiveWorkspaceTarget>
}

type MergeProgress = PipelineStoreFacts['mergeProgress'][number]

function mergeProgressFor(
  input: { watcherId: string; mergeId: string; epoch: number; childInstanceId: string },
  store: PipelineStore
): MergeProgress | undefined {
  return store
    .facts(input.watcherId)
    .mergeProgress.find(
      (row) =>
        row.mergeId === input.mergeId &&
        row.epoch === input.epoch &&
        row.childInstanceId === input.childInstanceId
    )
}

function caseInsensitivePaths(target: ObjectiveWorkspaceTarget): boolean {
  return resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
}

async function readCommitPaths(
  target: ObjectiveWorkspaceTarget,
  commitSha: string
): Promise<Set<string>> {
  if (!isObjectiveGitObjectId(commitSha)) {
    throw new Error('Applied child commit must be a Git object id')
  }
  const stdout = (
    await objectiveGitCommandForTarget(target)([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      `${commitSha}^`,
      commitSha
    ])
  ).stdout
  return new Set(
    stdout
      .split('\0')
      .filter(
        (path) => path.length > 0 && !isObjectiveMetadataPath(path, caseInsensitivePaths(target))
      )
  )
}

async function conflictingChildIds(
  target: ObjectiveWorkspaceTarget,
  conflictPaths: readonly string[],
  appliedChildren: readonly MergeAppliedChild[]
): Promise<string[]> {
  const conflicts = new Set(conflictPaths)
  const owners: string[] = []
  for (const child of appliedChildren) {
    const paths = await readCommitPaths(target, child.commitSha)
    if ([...paths].some((path) => conflicts.has(path))) {
      owners.push(child.taskId)
    }
  }
  return [...new Set(owners)]
}

function conflictResult(progress: MergeProgress | undefined): MergeChildResult | null {
  if (!progress || (progress.state !== 'conflict' && progress.state !== 'resolving')) {
    return null
  }
  if (!progress.conflict) {
    throw new Error('Pipeline conflict progress is missing its evidence')
  }
  return {
    status: 'conflict',
    conflictPaths: progress.conflict.paths,
    conflictingChildren: progress.conflict.conflictingChildren
  }
}

async function recordConflict(
  input: MergeChildInput,
  deps: MergeExecutorDeps,
  commitSha: string | null,
  target: ObjectiveWorkspaceTarget,
  conflictPaths: string[]
): Promise<MergeChildResult> {
  const conflictingChildren = await conflictingChildIds(
    target,
    conflictPaths,
    input.appliedChildren
  )
  await deps.lease.assertHeld()
  deps.store.setMergeProgress({
    watcherId: input.watcherId,
    mergeId: input.mergeId,
    epoch: input.epoch,
    childInstanceId: input.child.instanceId,
    state: 'conflict',
    commitSha,
    conflict: { paths: conflictPaths, conflictingChildren }
  })
  return { status: 'conflict', conflictPaths, conflictingChildren }
}

function storedApplied(progress: MergeProgress | undefined): MergeChildResult | null {
  if (progress?.state !== 'applied' || !progress.appliedCommitSha) {
    return null
  }
  return { status: 'applied', appliedCommitSha: progress.appliedCommitSha }
}

function validCommitSha(commitSha: string | null | undefined): commitSha is string {
  return commitSha !== null && commitSha !== undefined && isObjectiveGitObjectId(commitSha)
}

export type ReadMergeSourceFactsInput = {
  watcherId: string
  mergeId: string
  epoch: number
  childInstanceId: string
  workspacePath: string | null
  runWorkspacePath: string
  applicableBaseCommit: string
  childCommitSha?: string | null
}

async function loadMergeSourceFacts(
  input: ReadMergeSourceFactsInput,
  deps: Pick<MergeExecutorDeps, 'store' | 'resolveTarget'>
): Promise<PipelineMergeSourceFacts> {
  if (!isObjectiveGitObjectId(input.applicableBaseCommit)) {
    throw new Error('Pipeline merge base must be a Git commit')
  }
  if (
    input.childCommitSha !== undefined &&
    input.childCommitSha !== null &&
    !isObjectiveGitObjectId(input.childCommitSha)
  ) {
    throw new Error('Pipeline child commit must be a Git object id')
  }
  const workspacePath = input.workspacePath ?? input.runWorkspacePath
  const target = await resolveGitTarget(workspacePath, deps)
  const runGit = objectiveGitCommandForTarget(target)
  const [sourceHead, workspaceDigest, unmergedPaths] = await Promise.all([
    readHead(runGit),
    computeGitRepositoryIdentity(target, runGit, '', caseInsensitivePaths(target)),
    readUnmergedPaths(runGit)
  ])
  const progress = mergeProgressFor(input, deps.store)
  let committedChildSha =
    input.workspacePath !== null && sourceHead !== input.applicableBaseCommit ? sourceHead : null
  if (progress?.state === 'pending') {
    if (progress.commitSha !== null && !validCommitSha(progress.commitSha)) {
      throw new Error('Pipeline merge progress contains an invalid child commit')
    }
    committedChildSha = progress.commitSha
  } else if (progress?.state === 'resolved') {
    committedChildSha =
      input.workspacePath !== null && sourceHead !== input.applicableBaseCommit ? sourceHead : null
  } else if (input.childCommitSha !== undefined) {
    committedChildSha = input.childCommitSha
  }
  return {
    childInstanceId: input.childInstanceId,
    workspacePath: input.workspacePath,
    sourceHead,
    committedChildSha,
    workspaceDigest,
    applicableBaseCommit: input.applicableBaseCommit,
    unmergedPaths
  }
}

/** Reads the source commit, content digest and unmerged paths without modifying either workspace. */
export async function readMergeSourceFacts(
  input: ReadMergeSourceFactsInput,
  deps: Pick<MergeExecutorDeps, 'store' | 'resolveTarget'>
): Promise<PipelineMergeSourceFacts> {
  const workspacePath = input.workspacePath ?? input.runWorkspacePath
  return await runWithGitWorktreeOperationLock(workspacePath, undefined, () =>
    loadMergeSourceFacts(input, deps)
  )
}

function assertActionSource(input: MergeChildInput, source: PipelineMergeSourceFacts): void {
  if (
    source.childInstanceId !== input.child.instanceId ||
    source.workspacePath !== input.child.workspacePath ||
    source.sourceHead !== input.sourceHead ||
    source.committedChildSha !== input.childCommitSha ||
    source.workspaceDigest !== input.workspaceDigest ||
    source.applicableBaseCommit !== input.baseCommit
  ) {
    throw new Error('Pipeline Merge source changed after its action was recorded')
  }
}

async function createNormalizedChildCommit(
  input: MergeChildInput,
  deps: MergeExecutorDeps
): Promise<string> {
  const childWorkspacePath = input.child.workspacePath
  if (childWorkspacePath === null) {
    throw new Error('A private child workspace is required to create a squash commit')
  }
  return await runWithGitWorktreeOperationLock(childWorkspacePath, undefined, async () => {
    const source = await loadMergeSourceFacts(
      {
        watcherId: input.watcherId,
        mergeId: input.mergeId,
        epoch: input.epoch,
        childInstanceId: input.child.instanceId,
        workspacePath: childWorkspacePath,
        runWorkspacePath: input.runWorkspacePath,
        applicableBaseCommit: input.baseCommit,
        childCommitSha: input.childCommitSha
      },
      deps
    )
    assertActionSource(input, source)
    if (source.unmergedPaths.length > 0) {
      throw new Error('Pipeline child workspace has unresolved index entries')
    }
    const target = await resolveGitTarget(childWorkspacePath, deps)
    const runGit = objectiveGitCommandForTarget(target)
    const progress = mergeProgressFor(
      {
        watcherId: input.watcherId,
        mergeId: input.mergeId,
        epoch: input.epoch,
        childInstanceId: input.child.instanceId
      },
      deps.store
    )
    if (progress?.state === 'resolved') {
      await deps.lease.assertHeld()
      await runGit(['reset', '--mixed', input.baseCommit])
    }
    await deps.lease.assertHeld()
    deps.store.setMergeProgress({
      watcherId: input.watcherId,
      mergeId: input.mergeId,
      epoch: input.epoch,
      childInstanceId: input.child.instanceId,
      state: 'pending',
      commitSha: null
    })
    const normalized = await createObjectiveNodeCommit(
      target,
      {
        baseCommit: input.baseCommit,
        taskKey: input.child.taskId,
        title: `Pipeline task ${input.child.taskId}`,
        reportedPaths: []
      },
      deps.lease
    )
    await deps.lease.assertHeld()
    deps.store.setMergeProgress({
      watcherId: input.watcherId,
      mergeId: input.mergeId,
      epoch: input.epoch,
      childInstanceId: input.child.instanceId,
      state: 'pending',
      commitSha: normalized.commitSha
    })
    return normalized.commitSha
  })
}

/** Applies a child commit under the granted integration action and run-worktree mutation lock. */
export async function mergeChild(
  input: MergeChildInput,
  deps: MergeExecutorDeps
): Promise<MergeChildResult> {
  if (
    !isObjectiveGitObjectId(input.baseCommit) ||
    !isObjectiveGitObjectId(input.sourceHead) ||
    !/^[0-9a-f]{64}$/u.test(input.workspaceDigest) ||
    (input.childCommitSha !== null && !isObjectiveGitObjectId(input.childCommitSha))
  ) {
    throw new Error('Pipeline Merge action contains invalid source identity')
  }
  const actionKey = {
    watcherId: input.watcherId,
    mergeId: input.mergeId,
    epoch: input.epoch,
    childInstanceId: input.child.instanceId
  }
  const initialProgress = mergeProgressFor(actionKey, deps.store)
  const applied = storedApplied(initialProgress)
  if (applied) {
    return applied
  }
  const priorConflict = conflictResult(initialProgress)
  if (priorConflict) {
    return priorConflict
  }

  return await runWithGitWorktreeOperationLock(input.runWorkspacePath, undefined, async () => {
    const progress = mergeProgressFor(actionKey, deps.store)
    const appliedProgress = storedApplied(progress)
    if (appliedProgress) {
      return appliedProgress
    }
    const conflictProgress = conflictResult(progress)
    if (conflictProgress) {
      return conflictProgress
    }
    await deps.lease.assertHeld()
    const target = await resolveGitTarget(input.runWorkspacePath, deps)
    const runGit = objectiveGitCommandForTarget(target)
    let commitSha =
      progress?.state === 'pending' && validCommitSha(progress.commitSha)
        ? progress.commitSha
        : null

    if (commitSha === null) {
      if (input.child.workspacePath !== null) {
        commitSha = await createNormalizedChildCommit(input, deps)
      } else {
        const source = await loadMergeSourceFacts(
          {
            watcherId: input.watcherId,
            mergeId: input.mergeId,
            epoch: input.epoch,
            childInstanceId: input.child.instanceId,
            workspacePath: null,
            runWorkspacePath: input.runWorkspacePath,
            applicableBaseCommit: input.baseCommit,
            childCommitSha: input.childCommitSha
          },
          deps
        )
        assertActionSource(input, source)
        if (source.unmergedPaths.length > 0) {
          return await recordConflict(
            input,
            deps,
            input.childCommitSha,
            target,
            source.unmergedPaths
          )
        }
        if (input.childCommitSha === null) {
          await deps.lease.assertHeld()
          deps.store.setMergeProgress({
            watcherId: input.watcherId,
            mergeId: input.mergeId,
            epoch: input.epoch,
            childInstanceId: input.child.instanceId,
            state: 'applied',
            commitSha: null,
            appliedCommitSha: source.sourceHead,
            conflict: null
          })
          return { status: 'applied', appliedCommitSha: source.sourceHead }
        }
        if (!validCommitSha(input.childCommitSha)) {
          throw new Error('An isolated child commit is required for this Merge application')
        }
        commitSha = input.childCommitSha
        await deps.lease.assertHeld()
        deps.store.setMergeProgress({
          watcherId: input.watcherId,
          mergeId: input.mergeId,
          epoch: input.epoch,
          childInstanceId: input.child.instanceId,
          state: 'pending',
          commitSha,
          conflict: null
        })
      }
    }
    if (commitSha === null) {
      throw new Error('Pipeline child commit was not persisted before Merge')
    }
    if (input.child.workspacePath === null) {
      const sharedConflicts = await readUnmergedPaths(runGit)
      if (sharedConflicts.length > 0) {
        return await recordConflict(input, deps, commitSha, target, sharedConflicts)
      }
    }
    const recovered = await recoverObjectiveNodeApply(target, commitSha, deps.lease, {
      retry: false
    })
    if (recovered.kind === 'applied') {
      await deps.lease.assertHeld()
      deps.store.setMergeProgress({
        watcherId: input.watcherId,
        mergeId: input.mergeId,
        epoch: input.epoch,
        childInstanceId: input.child.instanceId,
        state: 'applied',
        commitSha,
        appliedCommitSha: recovered.appliedCommitSha,
        conflict: null
      })
      return { status: 'applied', appliedCommitSha: recovered.appliedCommitSha }
    }
    if (recovered.kind === 'conflict') {
      return await recordConflict(input, deps, commitSha, target, recovered.allConflictPaths)
    }
    if (recovered.kind === 'paused-dirty') {
      throw new Error(`Pipeline run worktree is dirty: ${recovered.paths.join(', ')}`)
    }
    const result = await applyObjectiveNodeCommit(target, commitSha, deps.lease)
    if (result.kind === 'conflict') {
      return await recordConflict(input, deps, commitSha, target, result.allConflictPaths)
    }
    if (result.kind === 'paused-dirty') {
      throw new Error(`Pipeline run worktree is dirty: ${result.paths.join(', ')}`)
    }
    await deps.lease.assertHeld()
    deps.store.setMergeProgress({
      watcherId: input.watcherId,
      mergeId: input.mergeId,
      epoch: input.epoch,
      childInstanceId: input.child.instanceId,
      state: 'applied',
      commitSha,
      appliedCommitSha: result.appliedCommitSha,
      conflict: null
    })
    return { status: 'applied', appliedCommitSha: result.appliedCommitSha }
  })
}
