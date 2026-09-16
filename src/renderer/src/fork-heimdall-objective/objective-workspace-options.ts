import type { AppState } from '@/store/types'
import type { ObjectiveWorkspaceKind } from '../../../shared/fork-heimdall-objective/contract-types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { HeimdallRemoteOwner } from '../../../shared/fork-heimdall/api'
import {
  filterEnabledTuiAgents,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../shared/tui-agent-selection'

export type ObjectiveWorkspaceOption = {
  key: string
  repoId: string
  repoPath: string
  worktreeId: string | null
  workspacePath: string
  branch: string | null
  workspaceKind: ObjectiveWorkspaceKind
  label: string
  detail: string
  owner: HeimdallRemoteOwner | undefined
  ownerUnavailable: boolean
  availableAgentIds: readonly string[]
}

type ObjectiveWorkspaceState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'runtimeEnvironments'
  | 'detectedAgentIds'
  | 'remoteDetectedAgentIds'
  | 'runtimeDetectedAgentIds'
  | 'settings'
>

function agentsForHost(state: ObjectiveWorkspaceState, hostId: string): readonly string[] {
  const host = parseExecutionHostId(hostId)
  const detected =
    host?.kind === 'runtime'
      ? (state.runtimeDetectedAgentIds?.[host.environmentId] ?? [])
      : host?.kind === 'ssh'
        ? (state.remoteDetectedAgentIds?.[host.targetId] ?? [])
        : (state.detectedAgentIds ?? [])
  return filterEnabledTuiAgents(
    TUI_AGENT_AUTO_PICK_ORDER.filter((agent) => detected.includes(agent)),
    state.settings?.disabledTuiAgents
  )
}

function remoteOwner(
  state: ObjectiveWorkspaceState,
  hostId: string
): Pick<ObjectiveWorkspaceOption, 'owner' | 'ownerUnavailable'> {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return { owner: undefined, ownerUnavailable: false }
  }
  const environment = state.runtimeEnvironments.find(
    (candidate) => candidate.id === host.environmentId
  )
  return environment
    ? {
        owner: {
          connectionId: environment.id,
          pairingRevision: environment.pairingRevision ?? environment.createdAt
        },
        ownerUnavailable: false
      }
    : { owner: undefined, ownerUnavailable: true }
}

export function buildObjectiveWorkspaceOptions(
  state: ObjectiveWorkspaceState
): ObjectiveWorkspaceOption[] {
  const options: ObjectiveWorkspaceOption[] = []
  for (const repo of state.repos) {
    const repoHostId = getRepoExecutionHostId(repo)
    if (isFolderRepo(repo)) {
      options.push({
        key: `${repoHostId}:${repo.id}:folder`,
        repoId: repo.id,
        repoPath: repo.path,
        worktreeId: null,
        workspacePath: repo.path,
        branch: null,
        workspaceKind: 'folder',
        label: repo.displayName,
        detail: `${repo.path} · ${repoHostId}`,
        ...remoteOwner(state, repoHostId),
        availableAgentIds: agentsForHost(state, repoHostId)
      })
      continue
    }
    for (const worktree of state.worktreesByRepo[repo.id] ?? []) {
      const worktreeHostId = getWorktreeExecutionHostId(worktree, repo)
      if (worktree.isArchived || worktree.isBare) {
        continue
      }
      options.push({
        key: `${worktreeHostId}:${repo.id}:${worktree.id}`,
        repoId: repo.id,
        repoPath: repo.path,
        worktreeId: worktree.id,
        workspacePath: worktree.path,
        branch: worktree.branch,
        workspaceKind: 'git',
        label: `${repo.displayName} / ${worktree.displayName || worktree.branch || worktree.path}`,
        detail: `${worktree.path} · ${worktreeHostId}`,
        ...remoteOwner(state, worktreeHostId),
        availableAgentIds: agentsForHost(state, worktreeHostId)
      })
    }
  }
  return options.sort((left, right) => left.label.localeCompare(right.label))
}
