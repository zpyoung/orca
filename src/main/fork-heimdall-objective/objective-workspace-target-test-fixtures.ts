import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { ObjectiveWorkspaceTarget } from './content-identity'

export function folderTarget(workspacePath: string): ObjectiveWorkspaceTarget {
  return { kind: 'folder', executionHostId: 'local', workspacePath, fileProvider: null }
}

export function gitTarget(
  workspacePath: string,
  overrides: {
    id?: string
    repoId?: string
    isMainWorktree?: boolean
    prunable?: boolean
  } = {}
): ObjectiveWorkspaceTarget {
  const {
    id = `objective-repo::${workspacePath}`,
    repoId = 'objective-repo',
    isMainWorktree = true,
    prunable
  } = overrides
  const runtimeTarget = {
    executionHostId: 'local',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test double of Worktree/GitWorktreeInfo; only the fields objective code reads (id, repoId, path, git) are populated.
    worktree: {
      id,
      repoId,
      path: workspacePath,
      git: {
        path: workspacePath,
        branch: 'main',
        isBare: false,
        isMainWorktree,
        ...(prunable === undefined ? {} : { prunable })
      }
    } as unknown as RuntimeGitTarget['worktree']
  } satisfies RuntimeGitTarget
  return {
    kind: 'git',
    executionHostId: 'local',
    workspacePath,
    fileProvider: null,
    gitTarget: runtimeTarget
  }
}
