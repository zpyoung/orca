import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type * as AbortableRuntimeEnvironmentCall from '../runtime/abortable-runtime-environment-call'
import {
  TEST_COMMIT_OID,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const TEST_WORKTREE = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/workspace/repo',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'repo',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  workspaceStatus: 'todo'
}

describe('web git preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
    vi.doUnmock('../runtime/abortable-runtime-environment-call')
  })

  it('routes remote commit URL requests through the runtime git API', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'repo.list') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repos: [{ id: 'repo-1' }] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repoId: 'repo-1', authoritative: true, worktrees: [TEST_WORKTREE] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'git.remoteCommitUrl') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: `https://git.example.com/project/commit/${TEST_COMMIT_OID}`,
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: false,
            error: { code: 'unexpected_method', message: `Unexpected method: ${method}` },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.git.remoteCommitUrl({
        worktreePath: '/workspace/repo',
        sha: TEST_COMMIT_OID
      })
    ).resolves.toBe(`https://git.example.com/project/commit/${TEST_COMMIT_OID}`)
    expect(runtimeCalls).toEqual([
      { method: 'repo.list', params: undefined },
      { method: 'worktree.detectedList', params: { repo: 'repo-1' } },
      { method: 'git.remoteCommitUrl', params: { worktree: 'id:wt-1', sha: TEST_COMMIT_OID } }
    ])
  })

  it('sends the branch line total merge base only when the chip asked for one', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'repo.list') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repos: [{ id: 'repo-1' }] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repoId: 'repo-1', authoritative: true, worktrees: [TEST_WORKTREE] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { entries: [], conflictOperation: 'unknown' },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.git.status({
      worktreePath: '/workspace/repo',
      branchLineTotalMergeBase: TEST_COMMIT_OID
    })
    await globals.window.api.git.status({ worktreePath: '/workspace/repo' })
    await globals.window.api.git.status({
      worktreePath: '/workspace/repo',
      includeLineStats: false
    })
    await globals.window.api.git.branchCompare({
      worktreePath: '/workspace/repo',
      baseRef: 'origin/main',
      admissionTier: 'background'
    })

    const statusCalls = runtimeCalls.filter((call) => call.method === 'git.status')
    // Why: strict — `toEqual` would pass on a forwarded `branchLineTotalMergeBase: undefined`,
    // which is exactly what the conditional spread must avoid sending.
    expect(statusCalls).toStrictEqual([
      {
        method: 'git.status',
        params: {
          worktree: 'id:wt-1',
          includeIgnored: undefined,
          includeLineStats: undefined,
          bypassEffectiveUpstreamNegativeCache: undefined,
          reuseLineStats: undefined,
          branchLineTotalMergeBase: TEST_COMMIT_OID
        }
      },
      {
        method: 'git.status',
        params: {
          worktree: 'id:wt-1',
          includeIgnored: undefined,
          includeLineStats: undefined,
          bypassEffectiveUpstreamNegativeCache: undefined,
          reuseLineStats: undefined
        }
      },
      {
        method: 'git.status',
        params: {
          worktree: 'id:wt-1',
          includeIgnored: undefined,
          includeLineStats: false,
          bypassEffectiveUpstreamNegativeCache: undefined,
          reuseLineStats: undefined
        }
      }
    ])
    expect(runtimeCalls.find((call) => call.method === 'git.branchCompare')).toStrictEqual({
      method: 'git.branchCompare',
      params: {
        worktree: 'id:wt-1',
        baseRef: 'origin/main',
        admissionTier: 'background'
      }
    })
  })

  it('registers a diff cancel token before resolving the request params', async () => {
    const detectedList = Promise.withResolvers<RuntimeRpcResponse<unknown>>()
    const abortableSignals: AbortSignal[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'repo.list') {
            return Promise.resolve({
              id: 'call-repos',
              ok: true,
              result: { repos: [{ id: 'repo-1' }] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.detectedList') {
            return detectedList.promise
          }
          return Promise.resolve({
            id: 'call-other',
            ok: false,
            error: { code: 'unexpected_method', message: `Unexpected method: ${method}` },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))
    vi.doMock('../runtime/abortable-runtime-environment-call', async (importOriginal) => {
      const actual = await importOriginal<typeof AbortableRuntimeEnvironmentCall>()
      return {
        ...actual,
        callAbortableRuntimeEnvironment: (
          _environmentId: string,
          _method: string,
          _params: unknown,
          _timeoutMs: number | undefined,
          signal: AbortSignal
        ): Promise<RuntimeRpcResponse<unknown>> => {
          abortableSignals.push(signal)
          return signal.aborted
            ? Promise.reject(actual.createRuntimeRpcAbortError())
            : Promise.resolve({
                id: 'call-diff',
                ok: true,
                result: { kind: 'text', originalContent: '', modifiedContent: 'hello' },
                _meta: { runtimeId: 'runtime-1' }
              })
        }
      }
    })

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    const { webGitDiffAbortControllers } = await import('./preload-api/web-git-api')
    installWebPreloadApi()

    const diff = globals.window.api.git.diff({
      worktreePath: '/workspace/repo',
      filePath: '/workspace/repo/src/file.ts',
      staged: false,
      requestToken: 'diff-1'
    })
    // The cancel has to find a controller while the worktree lookup is still in flight.
    await vi.waitFor(() => expect(webGitDiffAbortControllers.has('diff-1')).toBe(true))
    await globals.window.api.git.cancelDiff({ requestToken: 'diff-1' })
    detectedList.resolve({
      id: 'call-detected',
      ok: true,
      result: { repoId: 'repo-1', authoritative: true, worktrees: [TEST_WORKTREE] },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(diff).rejects.toThrow('Runtime request aborted')
    expect(abortableSignals).toHaveLength(1)
    expect(abortableSignals[0]?.aborted).toBe(true)
    expect(webGitDiffAbortControllers.size).toBe(0)
  })
})
