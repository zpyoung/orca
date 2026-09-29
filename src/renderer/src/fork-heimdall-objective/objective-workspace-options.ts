import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { collectActiveDashboardWorkspaces } from '@/components/dashboard/dashboard-snapshot-workspaces'
import type { ObjectiveWorkspaceKind } from '../../../shared/fork-heimdall-objective/contract-types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { HeimdallRemoteOwner } from '../../../shared/fork-heimdall/api'
import {
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../../shared/fork-heimdall/capability'
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
  parallelExecutionSupported?: boolean
  roleLaunchSupported?: boolean
  createsWorktree?: true
  availableAgentIds: readonly string[]
}

type ObjectiveWorkspaceState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'runtimeEnvironments'
  | 'detectedAgentIds'
  | 'remoteDetectedAgentIds'
  | 'runtimeDetectedAgentIds'
  | 'runtimeStatusByEnvironmentId'
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

function runtimeSupportsCapability(
  state: ObjectiveWorkspaceState,
  environmentId: string,
  capability: string
): boolean {
  return (
    state.runtimeStatusByEnvironmentId
      .get(environmentId)
      ?.status?.capabilities?.includes(capability) === true
  )
}

function remoteOwner(
  state: ObjectiveWorkspaceState,
  hostId: string
): Pick<
  ObjectiveWorkspaceOption,
  'owner' | 'ownerUnavailable' | 'parallelExecutionSupported' | 'roleLaunchSupported'
> {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return {
      owner: undefined,
      ownerUnavailable: false,
      parallelExecutionSupported: true,
      roleLaunchSupported: true
    }
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
        ownerUnavailable: false,
        parallelExecutionSupported: runtimeSupportsCapability(
          state,
          environment.id,
          HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
        ),
        roleLaunchSupported: runtimeSupportsCapability(
          state,
          environment.id,
          HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY
        )
      }
    : {
        owner: undefined,
        ownerUnavailable: true,
        parallelExecutionSupported: false,
        roleLaunchSupported: false
      }
}

export function buildObjectiveWorkspaceOptions(
  state: ObjectiveWorkspaceState
): ObjectiveWorkspaceOption[] {
  const options: ObjectiveWorkspaceOption[] = []
  const optionKeys = new Set<string>()
  for (const workspace of collectActiveDashboardWorkspaces(state)) {
    const { repo, worktree } = workspace
    if (worktree.isBare) {
      continue
    }
    const worktreeHostId = getWorktreeExecutionHostId(worktree, repo ?? undefined)
    const folder = workspace.workspaceKind === 'folder' || Boolean(repo && isFolderRepo(repo))
    const repoId = repo?.id ?? worktree.repoId
    const repoPath = repo?.path ?? worktree.path
    // Legacy folder projects resolve through their Repo root; canonical FolderWorkspace rows
    // have no Repo row, so enrollment must carry the scoped folder key to the runtime resolver.
    const worktreeId = folder && repo ? null : worktree.id
    const workspacePath = folder && repo ? repo.path : worktree.path
    const label = repo
      ? folder
        ? repo.displayName
        : `${repo.displayName} / ${worktree.displayName || worktree.branch || worktree.path}`
      : workspace.projectName === worktree.displayName
        ? worktree.displayName
        : `${workspace.projectName} / ${worktree.displayName}`
    const key = `${worktreeHostId}:${repoId}:${worktreeId ?? 'folder'}`
    optionKeys.add(key)
    options.push({
      key,
      repoId,
      repoPath,
      worktreeId,
      workspacePath,
      branch: folder ? null : worktree.branch,
      workspaceKind: folder ? 'folder' : 'git',
      label,
      detail: `${workspacePath} · ${worktreeHostId}`,
      ...remoteOwner(state, worktreeHostId),
      availableAgentIds: agentsForHost(state, worktreeHostId)
    })
  }
  for (const repo of state.repos) {
    if (isFolderRepo(repo)) {
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    const host = parseExecutionHostId(hostId)
    if (
      !host ||
      (host.kind === 'runtime' &&
        (!state.runtimeEnvironments.some((environment) => environment.id === host.environmentId) ||
          !runtimeSupportsCapability(
            state,
            host.environmentId,
            HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY
          )))
    ) {
      continue
    }
    options.push({
      key: `${hostId}:${repo.id}:new`,
      repoId: repo.id,
      repoPath: repo.path,
      worktreeId: null,
      workspacePath: repo.path,
      branch: null,
      workspaceKind: 'git',
      createsWorktree: true,
      label: translate(
        'fork.heimdallObjective.enrollment.newWorktreeInRepo',
        'New worktree in {{repo}}',
        { repo: repo.displayName }
      ),
      detail: `${repo.path} · ${hostId}`,
      ...remoteOwner(state, hostId),
      availableAgentIds: agentsForHost(state, hostId)
    })
  }
  // A folder Repo is independently authoritative; it remains eligible before its synthetic
  // worktree row is hydrated. The shared projection above supplies the row once available.
  for (const repo of state.repos) {
    if (!isFolderRepo(repo)) {
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    const key = `${hostId}:${repo.id}:folder`
    if (optionKeys.has(key)) {
      continue
    }
    options.push({
      key,
      repoId: repo.id,
      repoPath: repo.path,
      worktreeId: null,
      workspacePath: repo.path,
      branch: null,
      workspaceKind: 'folder',
      label: repo.displayName,
      detail: `${repo.path} · ${hostId}`,
      ...remoteOwner(state, hostId),
      availableAgentIds: agentsForHost(state, hostId)
    })
  }
  return options.sort((left, right) => left.label.localeCompare(right.label))
}
