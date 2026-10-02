import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import { runWithGitWorktreeOperationLock } from '../../shared/git-worktree-operation-lock'
import {
  objectiveGitCommandForTarget,
  type ObjectiveGitCommand,
  type ObjectiveWorkspaceTarget
} from '../fork-heimdall-objective/content-identity'
import { recoverObjectiveNodeApply } from '../fork-heimdall-objective/merge-train-git'
import { verifyPipelineConflictFiles } from './swarm-executor'

type PipelineMergeGitDependencies = Readonly<{
  lease: LeaseGuard
  resolveTarget(workspacePath: string): Promise<ObjectiveWorkspaceTarget>
}>

/** Resolves a workspace path to its authoritative Git target. */
export async function resolveGitTarget(
  workspacePath: string,
  deps: Pick<PipelineMergeGitDependencies, 'resolveTarget'>
): Promise<ObjectiveWorkspaceTarget> {
  const target = await deps.resolveTarget(workspacePath)
  if (target.kind !== 'git' || target.workspacePath !== workspacePath || !target.gitTarget) {
    throw new Error('Pipeline merge requires the authoritative Git workspace target')
  }
  return target
}

/** Reads and validates the Git HEAD from a workspace command. */
export async function readHead(runGit: ObjectiveGitCommand): Promise<string> {
  const head = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  if (!isObjectiveGitObjectId(head)) {
    throw new Error('Git returned an invalid worktree HEAD')
  }
  return head
}

/** Reads paths from Git's unmerged index. */
export async function readUnmergedPaths(runGit: ObjectiveGitCommand): Promise<string[]> {
  const { stdout } = await runGit(['ls-files', '--unmerged', '-z'])
  const records = stdout.split('\0')
  if (records.at(-1) === '') {
    records.pop()
  }
  const paths = records.map((record) => {
    const separator = record.indexOf('\t')
    if (separator < 1 || separator === record.length - 1) {
      throw new Error('Git returned malformed unmerged index output')
    }
    return record.slice(separator + 1)
  })
  return [...new Set(paths)].sort()
}

function gitExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }
  const code = error.code
  if (typeof code === 'number') {
    return code
  }
  if (typeof code === 'string' && /^\d+$/u.test(code)) {
    return Number(code)
  }
  return null
}

async function readCherryPickHead(runGit: ObjectiveGitCommand): Promise<string | null> {
  try {
    const sha = (
      await runGit(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD^{commit}'])
    ).stdout.trim()
    if (!isObjectiveGitObjectId(sha)) {
      throw new Error('Git returned an invalid CHERRY_PICK_HEAD')
    }
    return sha
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return null
    }
    throw error
  }
}

/** Rebases the one conflict candidate onto the already-merged run HEAD without aborting its cherry-pick. */
export async function prepareConflictResolution(
  input: { childWorkspacePath: string; mergedHead: string; childCommitSha: string },
  deps: Pick<PipelineMergeGitDependencies, 'lease' | 'resolveTarget'>
): Promise<{ status: 'conflict-in-place' } | { status: 'applied-cleanly' }> {
  if (!isObjectiveGitObjectId(input.mergedHead) || !isObjectiveGitObjectId(input.childCommitSha)) {
    throw new Error('Pipeline conflict resolution requires Git commit ids')
  }
  return await runWithGitWorktreeOperationLock(input.childWorkspacePath, undefined, async () => {
    const target = await resolveGitTarget(input.childWorkspacePath, deps)
    const runGit = objectiveGitCommandForTarget(target)
    const unmerged = await readUnmergedPaths(runGit)
    const cherryPickHead = await readCherryPickHead(runGit)
    if (unmerged.length > 0 || cherryPickHead !== null) {
      if (cherryPickHead !== input.childCommitSha) {
        throw new Error('Conflicted child worktree is applying a different commit')
      }
      return { status: 'conflict-in-place' }
    }
    const recovered = await recoverObjectiveNodeApply(target, input.childCommitSha, deps.lease, {
      retry: false
    })
    if (recovered.kind === 'applied' && recovered.appliedCommitSha !== input.childCommitSha) {
      const [head, parentRecord] = await Promise.all([
        readHead(runGit),
        runGit(['rev-list', '--parents', '-n', '1', 'HEAD']).then((result) =>
          result.stdout.trim().split(/\s+/u)
        )
      ])
      if (
        head !== recovered.appliedCommitSha ||
        parentRecord.length !== 2 ||
        parentRecord[0] !== head ||
        parentRecord[1] !== input.mergedHead
      ) {
        throw new Error('Recovered child commit is not the expected clean cherry-pick')
      }
      return { status: 'applied-cleanly' }
    }
    if (recovered.kind === 'paused-dirty') {
      throw new Error('Child worktree changed before conflict resolution')
    }
    if (recovered.kind === 'conflict') {
      throw new Error('Child worktree has an unrecorded conflict')
    }
    const currentHead = await readHead(runGit)
    if (currentHead !== input.childCommitSha && currentHead !== input.mergedHead) {
      throw new Error('Child worktree is not at the recorded source or merged base')
    }
    if (currentHead === input.childCommitSha) {
      await deps.lease.assertHeld()
      await runGit(['reset', '--hard', input.mergedHead])
    }
    try {
      await deps.lease.assertHeld()
      await runGit(['cherry-pick', '--keep-redundant-commits', input.childCommitSha])
      return { status: 'applied-cleanly' }
    } catch (error) {
      const [conflictPaths, cherryPickHead] = await Promise.all([
        readUnmergedPaths(runGit),
        readCherryPickHead(runGit)
      ])
      if (conflictPaths.length === 0 || cherryPickHead !== input.childCommitSha) {
        throw error
      }
      return { status: 'conflict-in-place' }
    }
  })
}

/** Verifies Git's unmerged index and the actual conflict-path contents on their execution host. */
export async function verifyConflictResolved(
  input: { childWorkspacePath: string; conflictPaths: string[] },
  deps: Pick<PipelineMergeGitDependencies, 'resolveTarget'>
): Promise<boolean> {
  const target = await resolveGitTarget(input.childWorkspacePath, deps)
  const runGit = objectiveGitCommandForTarget(target)
  if ((await readUnmergedPaths(runGit)).length > 0) {
    return false
  }
  return await verifyPipelineConflictFiles(target, input.conflictPaths)
}
