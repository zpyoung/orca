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
    deliver?.({
      id: 'req-1',
      ok: true,
      result: { subscriptionId: 'sub-1', ...snapshot },
      _meta: { runtimeId: 'r' }
    })

    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onSnapshot.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', state: 'running' })
  })

  it('sanitizes a malformed remote snapshot instead of forwarding a broken shape', async () => {
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

    // a host emitting a non-array `nodes` must not reach a `.map` call in a render component
    expect(() =>
      deliver?.({
        id: 'req-1',
        ok: true,
        result: { runId: 'run_1', nodes: {} },
        _meta: { runtimeId: 'r' }
      })
    ).not.toThrow()
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith({ runId: 'run_1' })
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

    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: 'transient', message: 'gone' })
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('classifies a method-not-found RPC failure as an unsupported-host error, not transient', async () => {
    let deliver: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        subscribe: vi.fn(async (_args: unknown, callbacks: { onResponse: typeof deliver }) => {
          deliver = callbacks.onResponse
          return { unsubscribe: vi.fn() }
        })
      }
    }
    const onError = vi.fn()
    await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      () => {},
      onError
    )

    deliver?.({
      id: 'req-1',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: pipeline.subscribe' }
    })

    expect(onError).toHaveBeenCalledExactlyOnceWith({
      kind: 'unsupported',
      message: 'Unknown method: pipeline.subscribe'
    })
  })

  it('classifies a transport-level method-not-found error the same way as an RPC-level one', async () => {
    let transportOnError: ((error: { code: string; message: string }) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        subscribe: vi.fn(
          async (_args: unknown, callbacks: { onError?: typeof transportOnError }) => {
            transportOnError = callbacks.onError
            return { unsubscribe: vi.fn() }
          }
        )
      }
    }
    const onError = vi.fn()
    await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      () => {},
      onError
    )

    transportOnError?.({ code: 'method_not_found', message: 'old host' })

    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: 'unsupported', message: 'old host' })
  })

  it('classifies a transport-level connection error as transient', async () => {
    let transportOnError: ((error: { code: string; message: string }) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      runtimeEnvironments: {
        subscribe: vi.fn(
          async (_args: unknown, callbacks: { onError?: typeof transportOnError }) => {
            transportOnError = callbacks.onError
            return { unsubscribe: vi.fn() }
          }
        )
      }
    }
    const onError = vi.fn()
    await subscribeToPipelineRunSnapshot(
      { kind: 'environment', environmentId: 'env-1' },
      'run-1',
      () => {},
      onError
    )

    transportOnError?.({ code: 'connection_lost', message: 'socket closed' })

    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: 'transient', message: 'socket closed' })
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

  it('routes a local target through the pipelineRuns IPC bridge, not runtime.call', async () => {
    const subscribeMock = vi.fn((_args: unknown, _onFrame: unknown) => vi.fn())
    ;(window as unknown as { api: unknown }).api = {
      pipelineRuns: { subscribe: subscribeMock }
    }

    await subscribeToPipelineRunSnapshot(
      { kind: 'local' },
      'run-1',
      () => {},
      () => {}
    )

    expect(subscribeMock).toHaveBeenCalledTimes(1)
    const [args] = subscribeMock.mock.calls[0]!
    expect(args).toMatchObject({ runId: 'run-1' })
    expect((args as { subscriptionId: string }).subscriptionId).toEqual(expect.any(String))
  })

  it('forwards a local snapshot frame to onSnapshot', async () => {
    let onFrame: ((frame: { type: string; snapshot?: unknown; error?: string }) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      pipelineRuns: {
        subscribe: vi.fn((_args: unknown, callback: typeof onFrame) => {
          onFrame = callback
          return vi.fn()
        })
      }
    }
    const onSnapshot = vi.fn()
    await subscribeToPipelineRunSnapshot({ kind: 'local' }, 'run-1', onSnapshot, () => {})

    const snapshot: PipelineRunSnapshotWire = { runId: 'run-1', state: 'running' }
    onFrame?.({ type: 'snapshot', snapshot })

    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot)
  })

  it('sanitizes a malformed local snapshot frame instead of forwarding a broken shape', async () => {
    let onFrame: ((frame: { type: string; snapshot?: unknown; error?: string }) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      pipelineRuns: {
        subscribe: vi.fn((_args: unknown, callback: typeof onFrame) => {
          onFrame = callback
          return vi.fn()
        })
      }
    }
    const onSnapshot = vi.fn()
    await subscribeToPipelineRunSnapshot({ kind: 'local' }, 'run-1', onSnapshot, () => {})

    expect(() =>
      onFrame?.({ type: 'snapshot', snapshot: { runId: 'run_1', nodes: {} } })
    ).not.toThrow()
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith({ runId: 'run_1' })
  })

  it('routes a local error frame to onError instead of onSnapshot', async () => {
    let onFrame: ((frame: { type: string; snapshot?: unknown; error?: string }) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      pipelineRuns: {
        subscribe: vi.fn((_args: unknown, callback: typeof onFrame) => {
          onFrame = callback
          return vi.fn()
        })
      }
    }
    const onSnapshot = vi.fn()
    const onError = vi.fn()
    await subscribeToPipelineRunSnapshot({ kind: 'local' }, 'run-1', onSnapshot, onError)

    onFrame?.({ type: 'error', error: 'Pipeline run run-1 was not found.' })

    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledExactlyOnceWith({
      kind: 'transient',
      message: 'Pipeline run run-1 was not found.'
    })
  })

  it('delegates a local unsubscribe to the bridge-returned unsubscribe function', async () => {
    const bridgeUnsubscribe = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      pipelineRuns: { subscribe: vi.fn(() => bridgeUnsubscribe) }
    }
    const subscription = await subscribeToPipelineRunSnapshot(
      { kind: 'local' },
      'run-1',
      () => {},
      () => {}
    )

    subscription.unsubscribe()
    expect(bridgeUnsubscribe).toHaveBeenCalledOnce()
  })
})
