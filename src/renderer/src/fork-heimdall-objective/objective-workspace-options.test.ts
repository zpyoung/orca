import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { getDefaultSettings } from '../../../shared/constants'
import { HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY } from '../../../shared/fork-heimdall/capability'
import { buildObjectiveWorkspaceOptions } from './objective-workspace-options'

type WorkspaceState = Parameters<typeof buildObjectiveWorkspaceOptions>[0]

function state(): WorkspaceState {
  return {
    repos: [
      {
        id: 'local-repo',
        path: '/repos/local',
        displayName: 'Local',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'git'
      },
      {
        id: 'ssh-repo',
        path: '/repos/ssh',
        displayName: 'Remote',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'ssh:build'
      },
      {
        id: 'runtime-repo',
        path: '/repos/runtime',
        displayName: 'Runtime',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:hermes'
      },
      {
        id: 'folder-repo',
        path: '/repos/folder',
        displayName: 'Folder',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'folder'
      }
    ],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [
      {
        id: 'hermes',
        name: 'Hermes',
        createdAt: 10,
        updatedAt: 20,
        pairingRevision: 22,
        lastUsedAt: null,
        runtimeId: 'runtime-hermes',
        endpoints: [],
        preferredEndpointId: 'ws-hermes'
      }
    ],
    detectedAgentIds: ['claude'],
    remoteDetectedAgentIds: { build: ['codex'] },
    runtimeDetectedAgentIds: { hermes: ['claude'] },
    runtimeStatusByEnvironmentId: new Map(),
    settings: getDefaultSettings('/tmp')
  }
}

function withRuntimeCapabilities(
  source: WorkspaceState,
  capabilities: RuntimeStatus['capabilities']
): WorkspaceState {
  source.runtimeStatusByEnvironmentId.set('hermes', {
    checkedAt: 1,
    status: {
      runtimeId: 'runtime-hermes',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities
    }
  })
  return source
}

describe('buildObjectiveWorkspaceOptions new worktree', () => {
  it('offers one new worktree per local and SSH git repo, including repos without hydrated worktrees', () => {
    const options = buildObjectiveWorkspaceOptions(state())

    expect(options.filter((option) => option.createsWorktree)).toMatchObject([
      {
        key: 'local:local-repo:new',
        worktreeId: null,
        repoPath: '/repos/local',
        workspacePath: '/repos/local',
        workspaceKind: 'git',
        branch: null,
        label: 'New worktree in Local',
        availableAgentIds: ['claude']
      },
      {
        key: 'ssh:build:ssh-repo:new',
        worktreeId: null,
        repoPath: '/repos/ssh',
        workspacePath: '/repos/ssh',
        workspaceKind: 'git',
        branch: null,
        label: 'New worktree in Remote',
        availableAgentIds: ['codex']
      }
    ])
    expect(options.find((option) => option.key === 'local:folder-repo:new')).toBeUndefined()
    expect(options.find((option) => option.key === 'local:folder-repo:folder')).toBeDefined()
  })

  it('omits runtime repos without advertised support or a known runtime environment', () => {
    expect(buildObjectiveWorkspaceOptions(withRuntimeCapabilities(state(), []))).not.toContainEqual(
      expect.objectContaining({ key: 'runtime:hermes:runtime-repo:new' })
    )
    expect(buildObjectiveWorkspaceOptions(state())).not.toContainEqual(
      expect.objectContaining({ key: 'runtime:hermes:runtime-repo:new' })
    )
    const unknownEnvironment = state()
    unknownEnvironment.runtimeEnvironments = []
    expect(buildObjectiveWorkspaceOptions(unknownEnvironment)).not.toContainEqual(
      expect.objectContaining({ key: 'runtime:hermes:runtime-repo:new' })
    )
  })

  it('offers a runtime repo when its host advertises new-worktree support', () => {
    const option = buildObjectiveWorkspaceOptions(
      withRuntimeCapabilities(state(), [HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY])
    ).find((candidate) => candidate.key === 'runtime:hermes:runtime-repo:new')

    expect(option).toMatchObject({
      createsWorktree: true,
      owner: { connectionId: 'hermes', pairingRevision: 22 },
      availableAgentIds: ['claude'],
      detail: '/repos/runtime · runtime:hermes'
    })
  })
})
