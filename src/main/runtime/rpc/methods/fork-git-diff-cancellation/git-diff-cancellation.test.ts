import '../../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { GIT_METHODS } from '../git'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'git.diff', params }
}

const DIFF_PARAMS = {
  worktree: 'id:wt-1',
  filePath: 'src/index.ts',
  staged: false,
  compareAgainstHead: true
}

function stubRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    getRuntimeGitDiff: vi.fn().mockResolvedValue({
      kind: 'text',
      originalContent: '',
      modifiedContent: 'hello',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
  } as unknown as OrcaRuntimeService
}

describe('git.diff cancellation', () => {
  it('leaves the signal undefined for a local dispatch', async () => {
    const runtime = stubRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    await dispatcher.dispatch(makeRequest(DIFF_PARAMS))

    expect(runtime.getRuntimeGitDiff).toHaveBeenCalledWith(
      'id:wt-1',
      'src/index.ts',
      false,
      true,
      undefined,
      undefined
    )
  })

  it('forwards the dispatch abort signal to the runtime diff reader', async () => {
    const runtime = stubRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
    const controller = new AbortController()

    await dispatcher.dispatch(makeRequest(DIFF_PARAMS), { signal: controller.signal })

    expect(runtime.getRuntimeGitDiff).toHaveBeenLastCalledWith(
      'id:wt-1',
      'src/index.ts',
      false,
      true,
      undefined,
      controller.signal
    )
  })
})
