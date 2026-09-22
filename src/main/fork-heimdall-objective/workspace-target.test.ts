import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from '../providers/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ResolvedRuntimeFileTarget } from '../runtime/runtime-file-command-target'
import { resolveObjectiveWorkspaceTarget } from './workspace-target'

const SSH_TARGET = 'objective-folder-target'

function enrollment(
  executionHostId: WatcherEnrollment['executionHostId'] = 'local'
): WatcherEnrollment {
  return {
    watcherId: 'objective-1',
    kind: 'objective',
    workspaceKey: `${executionHostId}::/srv/project`,
    executionHostId,
    repoId: 'folder-repo',
    worktreeId: null,
    workspacePath: '/srv/project',
    schedulerOwner: executionHostId === 'local' ? 'local_host_service' : 'ssh_bridge',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 10 },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  } as unknown as WatcherEnrollment
}

function fileTarget(executionHostId: WatcherEnrollment['executionHostId']) {
  return {
    executionHostId,
    worktree: {
      id: 'folder-repo::/srv/project',
      repoId: 'folder-repo',
      path: '/srv/project'
    }
  } as ResolvedRuntimeFileTarget
}

afterEach(() => unregisterSshFilesystemProvider(SSH_TARGET))

describe('resolveObjectiveWorkspaceTarget', () => {
  it('resolves a folder repo root by its canonical repo-path workspace id', async () => {
    const resolveRuntimeFileTarget = vi.fn().mockResolvedValue(fileTarget('local'))

    const target = await resolveObjectiveWorkspaceTarget(
      { resolveRuntimeFileTarget } as unknown as OrcaRuntimeService,
      enrollment()
    )

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder-repo::/srv/project')
    expect(resolveRuntimeFileTarget).not.toHaveBeenCalledWith('folder:folder-repo')
    expect(target).toEqual({
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/srv/project',
      fileProvider: null
    })
  })

  it('resolves a canonical folder workspace by its persisted folder key', async () => {
    const resolveRuntimeFileTarget = vi.fn().mockResolvedValue({
      ...fileTarget('local'),
      worktree: {
        id: 'folder:folder-1',
        repoId: 'folder-workspace:group-1',
        path: '/srv/project'
      }
    })
    const canonical = {
      ...enrollment(),
      repoId: 'folder-workspace:group-1',
      worktreeId: 'folder:folder-1'
    }

    const target = await resolveObjectiveWorkspaceTarget(
      { resolveRuntimeFileTarget } as unknown as OrcaRuntimeService,
      canonical
    )

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder:folder-1')
    expect(target).toMatchObject({
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/srv/project'
    })
  })

  it('keeps the canonical folder repo root bound to its enrolled SSH host', async () => {
    const provider = {} as IFilesystemProvider
    registerSshFilesystemProvider(SSH_TARGET, provider)
    const executionHostId = `ssh:${SSH_TARGET}` as const
    const resolveRuntimeFileTarget = vi.fn().mockResolvedValue(fileTarget(executionHostId))

    const target = await resolveObjectiveWorkspaceTarget(
      { resolveRuntimeFileTarget } as unknown as OrcaRuntimeService,
      enrollment(executionHostId)
    )

    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder-repo::/srv/project')
    expect(target.executionHostId).toBe(executionHostId)
    expect(target.workspacePath).toBe('/srv/project')
    expect(target.fileProvider).toBe(provider)
  })
})
