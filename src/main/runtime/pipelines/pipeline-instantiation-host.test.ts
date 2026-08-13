import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/types'
import type { OrcaRuntimeService } from '../orca-runtime'

const getRegisteredSshStateMock = vi.fn()

vi.mock('../../ipc/ssh', () => ({
  getRegisteredSshState: getRegisteredSshStateMock
}))
vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn(),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable'
}))

const { resolvePreflightExecutionHost } = await import('./pipeline-instantiation-host')

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo_1',
    path: '/repo',
    displayName: 'my-repo',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  } as Repo
}

function runtimeStub(overrides: Partial<OrcaRuntimeService> = {}) {
  return {
    resolveProjectRuntimeForWorktree: vi.fn().mockReturnValue(undefined),
    ...overrides
  } as unknown as OrcaRuntimeService
}

describe('resolvePreflightExecutionHost', () => {
  beforeEach(() => {
    getRegisteredSshStateMock.mockReset()
  })

  it('includes the registered SSH connection platform for an SSH host', () => {
    getRegisteredSshStateMock.mockReturnValue({
      targetId: 'conn_1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      remotePlatform: 'win32'
    })
    const host = resolvePreflightExecutionHost(
      runtimeStub(),
      repo({ connectionId: 'conn_1' }),
      'wt_origin'
    )
    expect(host).toEqual({ connectionId: 'conn_1', hostPlatform: 'win32' })
  })

  it('omits hostPlatform for an SSH host with no resolvable platform', () => {
    getRegisteredSshStateMock.mockReturnValue(undefined)
    const host = resolvePreflightExecutionHost(
      runtimeStub(),
      repo({ connectionId: 'conn_1' }),
      'wt_origin'
    )
    expect(host).toEqual({ connectionId: 'conn_1' })
  })

  it('omits hostPlatform for an SSH host whose state reports no platform', () => {
    getRegisteredSshStateMock.mockReturnValue({
      targetId: 'conn_1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    const host = resolvePreflightExecutionHost(
      runtimeStub(),
      repo({ connectionId: 'conn_1' }),
      'wt_origin'
    )
    expect(host).toEqual({ connectionId: 'conn_1' })
  })

  it('resolves a WSL host from the worktree runtime, unaffected by SSH state', () => {
    const runtime = runtimeStub({
      resolveProjectRuntimeForWorktree: vi
        .fn()
        .mockReturnValue({ status: 'resolved', runtime: { kind: 'wsl', distro: 'Ubuntu' } })
    })
    const host = resolvePreflightExecutionHost(runtime, repo({ connectionId: null }), 'wt_origin')
    expect(host).toEqual({ wslDistro: 'Ubuntu' })
    expect(getRegisteredSshStateMock).not.toHaveBeenCalled()
  })

  it('resolves a native host when neither SSH nor WSL apply', () => {
    const host = resolvePreflightExecutionHost(runtimeStub(), repo({ connectionId: null }), 'wt_origin')
    expect(host).toEqual({})
  })
})
