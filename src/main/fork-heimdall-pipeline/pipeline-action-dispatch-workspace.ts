import { lstat } from 'node:fs/promises'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import { objectiveGitCommandForTarget } from '../fork-heimdall-objective/content-identity'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolvePipelineChildTarget } from './pipeline-merge-source-reader'
import type { PipelineWorkspaceTarget } from './pipeline-report-path'
import type { ChildWorktreeFact } from './pipeline-action-identity'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import { text } from './pipeline-action-identity'

export async function composeTarget(
  target: ObjectiveWorkspaceTarget,
  workspaceId?: string
): Promise<PipelineWorkspaceTarget> {
  const pipelineTarget = {
    workspaceKind: target.kind,
    workspacePath: target.workspacePath,
    executionHostId: target.executionHostId,
    ...(workspaceId === undefined ? {} : { workspaceId })
  }
  if (target.kind !== 'git') {
    return pipelineTarget
  }
  const gitDir = (
    await objectiveGitCommandForTarget(target)(['rev-parse', '--absolute-git-dir'])
  ).stdout.replace(/[\r\n]+$/u, '')
  if (gitDir.length === 0) {
    throw new Error('Git did not return an absolute pipeline report directory')
  }
  return { ...pipelineTarget, gitDir }
}

function safeRelativePath(target: ObjectiveWorkspaceTarget, relativePath: string): string | null {
  const path = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..')
  ) {
    return null
  }
  const resolvedRoot = path.resolve(target.workspacePath)
  const resolvedPath = path.resolve(resolvedRoot, relativePath)
  return path.relative(resolvedRoot, resolvedPath).startsWith('..') ? null : resolvedPath
}

export async function fileExists(
  target: ObjectiveWorkspaceTarget,
  relativePath: string
): Promise<boolean> {
  const absolutePath = safeRelativePath(target, relativePath)
  if (absolutePath === null) {
    return false
  }
  try {
    if (target.fileProvider === null) {
      return (await lstat(absolutePath)).isFile()
    }
    const info = target.fileProvider.lstat
      ? await target.fileProvider.lstat(absolutePath)
      : await target.fileProvider.stat(absolutePath)
    return info.type === 'file'
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    if (error instanceof Error && /no such file/iu.test(error.message)) {
      return false
    }
    throw error
  }
}

export async function childContext(
  action: KernelAction,
  world: PipelineReadyWorld,
  runtime: OrcaRuntimeService,
  recordFact: ChildWorktreeFact | null
): Promise<ObjectiveWorkspaceTarget> {
  const childInstanceId = text(action, 'childInstanceId')
  if (childInstanceId === null || recordFact === null || recordFact.setupState !== 'ready') {
    throw new Error('Pipeline child worktree is not recorded and ready')
  }
  return resolvePipelineChildTarget({
    runtime,
    enrollment: world.enrollment,
    instanceId: childInstanceId,
    epoch: recordFact.epoch,
    worktreeId: recordFact.worktreeId
  })
}

export function assertRunWorkspace(
  world: PipelineReadyWorld,
  target: ObjectiveWorkspaceTarget
): void {
  if (
    target.workspacePath !== world.enrollment.workspacePath ||
    target.executionHostId !== world.enrollment.executionHostId ||
    target.kind !== world.payload.workspaceKind
  ) {
    throw new Error('Pipeline workspace authority changed')
  }
}

export async function readHead(target: ObjectiveWorkspaceTarget): Promise<string> {
  if (target.kind !== 'git') {
    throw new Error('Pipeline Swarm requires an authoritative Git workspace')
  }
  const head = (
    await objectiveGitCommandForTarget(target)(['rev-parse', '--verify', 'HEAD'])
  ).stdout.trim()
  if (!isObjectiveGitObjectId(head)) {
    throw new Error('Run worktree HEAD is not a Git commit')
  }
  return head
}
