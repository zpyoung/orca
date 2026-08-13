// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRunSnapshotWire } from '../../../shared/pipeline-run-snapshot'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { subscribeToPipelineRunSnapshot } from './pipeline-run-client'

describe('subscribeToPipelineRunSnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    ;(window as unknown as { api?: unknown }).api = undefined
  })

  it('subscribes over runtimeEnvironments for an environment target with the right selector/method/params', async () => {
    const subscribeMock = vi.fn(async (_args: unknown, _callbacks: unknown) => ({
      unsubscribe: vi.fn()
    }))
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: { subscribe: subscribeMock }
    }

    await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      () => {},
      () => {}
    )

    expect(subscribeMock).toHaveBeenCalledTimes(1)
    const [args] = subscribeMock.mock.calls[0]!
    expect(args).toMatchObject({
      selector: 'env-1',
      method: 'pipeline.subscribe',
      params: { runId: 'run-1' }
    })
  })

  it('forwards a successful snapshot response to onSnapshot', async () => {
    let deliver: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        subscribe: vi.fn(async (_args: unknown, callbacks: { onResponse: typeof deliver }) => {
          deliver = callbacks.onResponse
          return { unsubscribe: vi.fn() }
        })
      }
    }
    const onSnapshot = vi.fn()
    await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      onSnapshot,
      () => {}
    )

    const snapshot: PipelineRunSnapshotWire = { runId: 'run-1', state: 'running' }
    deliver?.({ id: 'req-1', ok: true, result: { subscriptionId: 'sub-1', ...snapshot }, _meta: { runtimeId: 'r' } })

    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onSnapshot.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', state: 'running' })
  })

  it('routes an error response to onError instead of onSnapshot', async () => {
    let deliver: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        subscribe: vi.fn(async (_args: unknown, callbacks: { onResponse: typeof deliver }) => {
          deliver = callbacks.onResponse
          return { unsubscribe: vi.fn() }
        })
      }
    }
    const onSnapshot = vi.fn()
    const onError = vi.fn()
    await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      onSnapshot,
      onError
    )

    deliver?.({ id: 'req-1', ok: false, error: { code: 'run_not_found', message: 'gone' } })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('ignores keepalive frames without calling onSnapshot or onError', async () => {
    let deliver: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        subscribe: vi.fn(async (_args: unknown, callbacks: { onResponse: typeof deliver }) => {
          deliver = callbacks.onResponse
          return { unsubscribe: vi.fn() }
        })
      }
    }
    const onSnapshot = vi.fn()
    const onError = vi.fn()
    await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      onSnapshot,
      onError
    )

    deliver?.({ _keepalive: true } as unknown as RuntimeRpcResponse<unknown>)

    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('delegates unsubscribe to the underlying subscription handle', async () => {
    const underlyingUnsubscribe = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        subscribe: vi.fn(async () => ({ unsubscribe: underlyingUnsubscribe }))
      }
    }
    const subscription = await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      () => {},
      () => {}
    )
    subscription.unsubscribe()
    expect(underlyingUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('reports an error for a local target, since no local streaming bridge exists yet', async () => {
    const callMock = vi.fn(async () => ({
      id: 'req-1',
      ok: false,
      error: { code: 'method_not_supported', message: 'Method pipeline.subscribe requires a streaming transport' }
    }))
    ;(window as unknown as { api: unknown }).api = {
      runtime: { call: callMock }
    }
    const onSnapshot = vi.fn()
    const onError = vi.fn()
    const subscription = await subscribeToPipelineRunSnapshot(
      { kind: 'local' },
      'run-1',
      onSnapshot,
      onError
    )

    expect(callMock).toHaveBeenCalledWith({ method: 'pipeline.subscribe', params: { runId: 'run-1' } })
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    // Why: nothing was ever subscribed locally, so unsubscribe must be a harmless no-op.
    expect(() => subscription.unsubscribe()).not.toThrow()
  })
})
