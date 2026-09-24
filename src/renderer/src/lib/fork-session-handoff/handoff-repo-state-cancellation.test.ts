import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { getRuntimeGitDiff } from '@/runtime/runtime-git-client'
import type { HandoffTargetResolution } from './handoff-target-resolution'
import { fetchHandoffRepoState } from './handoff-repo-state'

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: vi.fn()
}))

const gitStatus = vi.fn()
const gitCancelStatus = vi.fn()
const gitDiff = vi.fn()
const gitCancelDiff = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()

const status = {
  branch: 'feature/handoff',
  conflictOperation: 'unknown' as const,
  entries: [{ path: 'src/changed.ts', status: 'modified' as const, area: 'unstaged' as const }]
}

function target(overrides: Partial<HandoffTargetResolution> = {}): HandoffTargetResolution {
  return {
    worktreeId: 'repo::/worktree',
    workspacePath: '/worktree',
    initialCwd: '/worktree',
    sshConnectionId: null,
    runtimeEnvironmentId: null,
    isFolderWorkspace: false,
    ...overrides
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.mocked(getSettingsForWorktreeRuntimeOwner).mockReset()
  gitStatus.mockReset()
  gitCancelStatus.mockReset()
  gitCancelStatus.mockResolvedValue(undefined)
  gitDiff.mockReset()
  gitCancelDiff.mockReset()
  gitCancelDiff.mockResolvedValue(undefined)
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      git: {
        status: gitStatus,
        cancelStatus: gitCancelStatus,
        diff: gitDiff,
        cancelDiff: gitCancelDiff
      },
      runtime: { call: vi.fn() },
      runtimeEnvironments: {
        call: runtimeEnvironmentCall,
        subscribe: runtimeEnvironmentSubscribe
      }
    }
  })
})

describe('handoff repo-state diff cancellation', () => {
  it('does not start local diff work for a pre-aborted request', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      getRuntimeGitDiff(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'repo::/worktree',
          worktreePath: '/worktree',
          connectionId: 'ssh-dev'
        },
        { filePath: 'src/changed.ts', staged: false, signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(gitDiff).not.toHaveBeenCalled()
    expect(gitCancelDiff).not.toHaveBeenCalled()
  })

  it('removes cancellation after a signalled local diff settles', async () => {
    gitDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'before',
      modifiedContent: 'after',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    const controller = new AbortController()

    await getRuntimeGitDiff(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'repo::/worktree',
        worktreePath: '/worktree',
        connectionId: 'ssh-dev'
      },
      { filePath: 'src/changed.ts', staged: false, signal: controller.signal }
    )
    controller.abort()

    expect(gitCancelDiff).not.toHaveBeenCalled()
  })

  it('aborts a pending SSH IPC diff and rejects the handoff promptly', async () => {
    vi.mocked(getSettingsForWorktreeRuntimeOwner).mockReturnValue({
      activeRuntimeEnvironmentId: null
    })
    gitStatus.mockResolvedValue(status)
    const diff = Promise.withResolvers<never>()
    gitDiff.mockReturnValue(diff.promise)
    const controller = new AbortController()

    const pending = fetchHandoffRepoState({
      state: { settings: null },
      target: target({ sshConnectionId: 'ssh-dev' }),
      includeDiffBodies: true,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(gitDiff).toHaveBeenCalledOnce())
    const requestToken = gitDiff.mock.calls[0]?.[0]?.requestToken

    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion

    expect(gitCancelDiff).toHaveBeenCalledWith({ requestToken })
    expect(requestToken).toEqual(expect.any(String))
  })

  it('aborts a pending remote-runtime diff without serializing the signal', async () => {
    vi.mocked(getSettingsForWorktreeRuntimeOwner).mockReturnValue({
      activeRuntimeEnvironmentId: 'env-1'
    })
    const diffUnsubscribe = vi.fn()
    const stalledCall = Promise.withResolvers<never>()
    runtimeEnvironmentCall.mockImplementation((request) => {
      if (request.method === 'status.get') {
        return Promise.resolve(createCompatibleRuntimeStatusResponse())
      }
      return stalledCall.promise
    })
    runtimeEnvironmentSubscribe.mockImplementation((request, callbacks) => {
      if (request.method === 'git.status') {
        callbacks.onResponse({
          id: 'status',
          ok: true,
          result: status,
          _meta: { runtimeId: 'remote-runtime' }
        })
        return Promise.resolve({ unsubscribe: vi.fn() })
      }
      return Promise.resolve({ unsubscribe: diffUnsubscribe })
    })
    const controller = new AbortController()

    const pending = fetchHandoffRepoState({
      state: { settings: null },
      target: target({ runtimeEnvironmentId: 'env-1' }),
      includeDiffBodies: true,
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(runtimeEnvironmentSubscribe).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'git.diff' }),
        expect.anything()
      )
    )

    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion

    expect(diffUnsubscribe).toHaveBeenCalledOnce()
    const diffRequest = runtimeEnvironmentSubscribe.mock.calls.find(
      ([request]) => request.method === 'git.diff'
    )?.[0]
    expect(diffRequest?.params).toEqual({
      worktree: 'id:repo::/worktree',
      filePath: 'src/changed.ts',
      staged: false
    })
  })
})
