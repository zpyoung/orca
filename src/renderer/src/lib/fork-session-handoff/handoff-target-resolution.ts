import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { detectAgentSessionContinuationAgents } from '@/lib/launch-agent-session-continuation'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getFolderWorkspaceCandidateRepos } from '@/lib/folder-workspace-connection'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'

export type HandoffTargetResolution = {
  worktreeId: string
  workspacePath: string
  initialCwd: string
  sshConnectionId: string | null
  runtimeEnvironmentId: string | null
  isFolderWorkspace: boolean
}

export type HandoffTargetCandidate = {
  worktreeId: string
  displayName: string
  workspacePath: string
  isFolderWorkspace: boolean
}

export type HandoffAgentDetectionResult = {
  agents: TuiAgent[]
  selectedAgent: TuiAgent | null
}

type HandoffTargetState = Pick<
  AppState,
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'worktreesByRepo'
>

type DetectAgents = (worktreeId: string) => Promise<TuiAgent[]>

/** Lists same-repository worktrees and folder workspaces that contain the anchor repo. */
export function listHandoffTargetCandidates(
  state: HandoffTargetState,
  anchorWorktreeId: string
): HandoffTargetCandidate[] {
  const candidates = new Map<string, HandoffTargetCandidate>()
  const repoIds = getAnchorRepoIds(state, anchorWorktreeId)

  for (const repoId of repoIds) {
    for (const worktree of state.worktreesByRepo[repoId] ?? []) {
      candidates.set(worktree.id, {
        worktreeId: worktree.id,
        displayName: worktree.displayName,
        workspacePath: worktree.path,
        isFolderWorkspace: false
      })
    }
  }

  for (const workspace of state.folderWorkspaces) {
    const workspaceRepoIds = getFolderWorkspaceCandidateRepos(state, workspace.id).map(
      (repo) => repo.id
    )
    const sharesRepo = workspaceRepoIds.some((repoId) => repoIds.has(repoId))
    const isAnchorFolder = folderWorkspaceKey(workspace.id) === anchorWorktreeId
    if (!sharesRepo && !isAnchorFolder) {
      continue
    }
    const worktreeId = folderWorkspaceKey(workspace.id)
    candidates.set(worktreeId, {
      worktreeId,
      displayName: workspace.name,
      workspacePath: workspace.folderPath,
      isFolderWorkspace: true
    })
  }

  return [...candidates.values()]
}

/** Resolves a target workspace and its local, SSH, or runtime execution route. */
export function resolveHandoffTarget(
  state: HandoffTargetState,
  requestedWorktreeId: string
): HandoffTargetResolution | null {
  const workspaceScope = parseWorkspaceKey(requestedWorktreeId)
  if (workspaceScope?.type === 'folder') {
    const workspace = state.folderWorkspaces.find(
      (entry) => entry.id === workspaceScope.folderWorkspaceId
    )
    if (!workspace) {
      return null
    }
    return resolveExecutionRoute(state, {
      worktreeId: folderWorkspaceKey(workspace.id),
      workspacePath: workspace.folderPath,
      isFolderWorkspace: true
    })
  }

  const worktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : requestedWorktreeId
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
  if (!worktree) {
    return null
  }
  return resolveExecutionRoute(state, {
    worktreeId,
    workspacePath: worktree.path,
    isFolderWorkspace: false
  })
}

/** Returns the git repo id used for inline worktree creation, or null for folder sources. */
export function getHandoffAnchorRepoId(
  state: Pick<HandoffTargetState, 'folderWorkspaces' | 'repos' | 'worktreesByRepo'>,
  anchorWorktreeId: string
): string | null {
  const workspaceScope = parseWorkspaceKey(anchorWorktreeId)
  if (workspaceScope?.type === 'folder') {
    return null
  }
  const worktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : anchorWorktreeId
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos.find((entry) => entry.id === repoId)
  return repo && !isFolderRepo(repo) ? repo.id : null
}

/** Produces the canonical host id used for host-change and reachability verdicts. */
export function resolveHandoffTargetExecutionHostId(
  target: HandoffTargetResolution
): ExecutionHostId {
  if (target.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(target.runtimeEnvironmentId)
  }
  if (target.sshConnectionId) {
    return toSshExecutionHostId(target.sshConnectionId)
  }
  return LOCAL_EXECUTION_HOST_ID
}

/** Reports whether sending to the target crosses a known execution-host boundary. */
export function resolveHandoffHostChange(
  sourceExecutionHostId: string | null,
  target: HandoffTargetResolution
): boolean {
  const targetHostId = resolveHandoffTargetExecutionHostId(target)
  const sourceHostId = normalizeExecutionHostId(sourceExecutionHostId)
  if (!sourceHostId) {
    return targetHostId !== LOCAL_EXECUTION_HOST_ID
  }
  return sourceHostId !== targetHostId
}

/** Creates a target detector that discards completions from older request generations. */
export function createHandoffAgentDetectionGeneration(
  detectAgents: DetectAgents = detectAgentSessionContinuationAgents
): {
  detect: (
    worktreeId: string,
    selectedAgent: TuiAgent | null
  ) => Promise<HandoffAgentDetectionResult | null>
  invalidate: () => void
} {
  let generation = 0
  return {
    async detect(worktreeId, selectedAgent) {
      const requestGeneration = ++generation
      try {
        const agents = await detectAgents(worktreeId)
        if (requestGeneration !== generation) {
          return null
        }
        return {
          agents,
          selectedAgent: selectedAgent && agents.includes(selectedAgent) ? selectedAgent : null
        }
      } catch (error) {
        if (requestGeneration !== generation) {
          return null
        }
        throw error
      }
    },
    invalidate() {
      generation += 1
    }
  }
}

function resolveExecutionRoute(
  state: HandoffTargetState,
  target: Pick<HandoffTargetResolution, 'worktreeId' | 'workspacePath' | 'isFolderWorkspace'>
): HandoffTargetResolution | null {
  const sshConnectionId = getConnectionIdFromState(state, target.worktreeId)
  if (sshConnectionId === undefined) {
    return null
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, target.worktreeId)
  return {
    ...target,
    initialCwd: target.workspacePath,
    sshConnectionId,
    runtimeEnvironmentId
  }
}

function getAnchorRepoIds(state: HandoffTargetState, anchorWorktreeId: string): Set<string> {
  const workspaceScope = parseWorkspaceKey(anchorWorktreeId)
  if (workspaceScope?.type === 'folder') {
    return new Set(
      getFolderWorkspaceCandidateRepos(state, workspaceScope.folderWorkspaceId).map(
        (repo) => repo.id
      )
    )
  }
  const worktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : anchorWorktreeId
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
  return new Set([worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)])
}
