import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRunSnapshotWire } from '../../shared/pipeline-run-snapshot'

const { handlers, listeners, subscribeToPipelineRunMock } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  subscribeToPipelineRunMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      listeners.set(channel, handler)
    })
  }
}))

vi.mock('../runtime/pipelines/pipeline-run-lifecycle', () => ({
  subscribeToPipelineRun: subscribeToPipelineRunMock
}))

import {
  _getPipelineRunSenderCleanupCountForTest,
  clearPipelineRunSubscriptions,
  MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER,
  registerPipelineSubscriptionHandlers
} from './pipeline-subscription'

type SenderHarness = {
  destroy: () => void
  registeredCleanupCount: () => number
  sender: {
    id: number
    isDestroyed: () => boolean
    once: (event: string, callback: () => void) => void
    send: ReturnType<typeof vi.fn>
  }
}

function createSender(id: number): SenderHarness {
  let destroyed = false
  const destroyedCallbacks: (() => void)[] = []
  return {
    destroy: () => {
      destroyed = true
      for (const callback of destroyedCallbacks) {
        callback()
      }
    },
    registeredCleanupCount: () => destroyedCallbacks.length,
    sender: {
      id,
      isDestroyed: () => destroyed,
      once: (event, callback) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      },
      send: vi.fn()
    }
  }
}

const fakeDb = { marker: 'orchestration-db' }
const runtime = { getOrchestrationDb: () => fakeDb } as never

function subscribe(sender: SenderHarness['sender'], subscriptionId: string, runId: string): void {
  const listener = listeners.get('pipelineRun:subscribe')
  if (!listener) {
    throw new Error('subscribe listener not registered')
  }
  listener({ sender }, { subscriptionId, runId })
}

function unsubscribe(sender: SenderHarness['sender'], subscriptionId: string): void {
  const listener = listeners.get('pipelineRun:unsubscribe')
  if (!listener) {
    throw new Error('unsubscribe listener not registered')
  }
  listener({ sender }, { subscriptionId })
}

type CapturedSubscribeCall = {
  db: unknown
  runId: string
  emit: (snapshot: PipelineRunSnapshotWire) => void
}

function capturedCall(callIndex: number): CapturedSubscribeCall {
  const call = subscribeToPipelineRunMock.mock.calls[callIndex]
  if (!call) {
    throw new Error('subscribeToPipelineRun was not called')
  }
  return { db: call[0], runId: call[1], emit: call[2] }
}

beforeEach(() => {
  clearPipelineRunSubscriptions()
  handlers.clear()
  listeners.clear()
  subscribeToPipelineRunMock.mockReset()
  registerPipelineSubscriptionHandlers(runtime)
})

describe('pipeline run subscription bridge', () => {
  it('delivers the on-attach snapshot and subsequent snapshots to the renderer callback', () => {
    const hostUnsubscribe = vi.fn()
    subscribeToPipelineRunMock.mockReturnValueOnce(hostUnsubscribe)
    const renderer = createSender(1)

    subscribe(renderer.sender, 'sub-1', 'run-1')
    const call = capturedCall(0)
    expect(call.db).toBe(fakeDb)
    expect(call.runId).toBe('run-1')

    const attachSnapshot: PipelineRunSnapshotWire = { runId: 'run-1', state: 'running' }
    call.emit(attachSnapshot)
    expect(renderer.sender.send).toHaveBeenCalledWith('pipelineRun:snapshot', {
      subscriptionId: 'sub-1',
      frame: { type: 'snapshot', snapshot: attachSnapshot }
    })

    const heartbeatSnapshot: PipelineRunSnapshotWire = { runId: 'run-1', state: 'running' }
    call.emit(heartbeatSnapshot)
    expect(renderer.sender.send).toHaveBeenCalledWith('pipelineRun:snapshot', {
      subscriptionId: 'sub-1',
      frame: { type: 'snapshot', snapshot: heartbeatSnapshot }
    })
    expect(renderer.sender.send).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe releases the host subscription', () => {
    const hostUnsubscribe = vi.fn()
    subscribeToPipelineRunMock.mockReturnValueOnce(hostUnsubscribe)
    const renderer = createSender(2)

    subscribe(renderer.sender, 'sub-2', 'run-2')
    expect(hostUnsubscribe).not.toHaveBeenCalled()

    unsubscribe(renderer.sender, 'sub-2')
    expect(hostUnsubscribe).toHaveBeenCalledOnce()
  })

  it('releases every subscription for a renderer that goes away', () => {
    const hostUnsubscribeA = vi.fn()
    const hostUnsubscribeB = vi.fn()
    subscribeToPipelineRunMock
      .mockReturnValueOnce(hostUnsubscribeA)
      .mockReturnValueOnce(hostUnsubscribeB)
    const renderer = createSender(3)

    subscribe(renderer.sender, 'sub-a', 'run-a')
    subscribe(renderer.sender, 'sub-b', 'run-b')
    expect(_getPipelineRunSenderCleanupCountForTest()).toBe(1)

    renderer.destroy()
    expect(hostUnsubscribeA).toHaveBeenCalledOnce()
    expect(hostUnsubscribeB).toHaveBeenCalledOnce()
    expect(_getPipelineRunSenderCleanupCountForTest()).toBe(0)
  })

  it('reports an unknown run id as an error frame instead of throwing', () => {
    subscribeToPipelineRunMock.mockImplementationOnce(() => {
      throw new Error('Pipeline run run-missing was not found.')
    })
    const renderer = createSender(4)

    expect(() => subscribe(renderer.sender, 'sub-4', 'run-missing')).not.toThrow()
    expect(renderer.sender.send).toHaveBeenCalledWith('pipelineRun:snapshot', {
      subscriptionId: 'sub-4',
      frame: { type: 'error', error: 'Pipeline run run-missing was not found.' }
    })
  })

  it('rejects a subscribe beyond the per-sender cap instead of leaking another host subscription', () => {
    subscribeToPipelineRunMock.mockImplementation(() => vi.fn())
    const renderer = createSender(6)

    for (let i = 0; i < MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER; i++) {
      subscribe(renderer.sender, `sub-${i}`, `run-${i}`)
    }
    expect(subscribeToPipelineRunMock).toHaveBeenCalledTimes(MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER)

    subscribe(renderer.sender, 'sub-overflow', 'run-overflow')

    // the overflow attempt must not create a host subscription — that's the leak this bounds
    expect(subscribeToPipelineRunMock).toHaveBeenCalledTimes(MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER)
    expect(renderer.sender.send).toHaveBeenCalledWith('pipelineRun:snapshot', {
      subscriptionId: 'sub-overflow',
      frame: {
        type: 'error',
        error: expect.stringContaining(String(MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER))
      }
    })
  })

  it('does not let a same-id resubscribe count against the per-sender cap', () => {
    subscribeToPipelineRunMock.mockImplementation(() => vi.fn())
    const renderer = createSender(7)

    for (let i = 0; i < MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER; i++) {
      subscribe(renderer.sender, `sub-${i}`, `run-${i}`)
    }
    // resubscribing under an already-live id replaces it — no net growth, so it must still succeed
    subscribe(renderer.sender, 'sub-0', 'run-0-again')

    expect(subscribeToPipelineRunMock).toHaveBeenCalledTimes(MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER + 1)
    const lastCall = capturedCall(MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER)
    expect(lastCall.runId).toBe('run-0-again')
  })

  it('scopes the subscription cap per sender, not globally', () => {
    subscribeToPipelineRunMock.mockImplementation(() => vi.fn())
    const rendererA = createSender(8)
    const rendererB = createSender(9)

    for (let i = 0; i < MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER; i++) {
      subscribe(rendererA.sender, `a-sub-${i}`, `run-${i}`)
    }
    subscribe(rendererB.sender, 'b-sub-0', 'run-b-0')

    expect(subscribeToPipelineRunMock).toHaveBeenCalledTimes(MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER + 1)
    expect(rendererB.sender.send).not.toHaveBeenCalled()
  })

  it('drops a malformed subscribe message instead of throwing', () => {
    const listener = listeners.get('pipelineRun:subscribe')
    if (!listener) {
      throw new Error('subscribe listener not registered')
    }
    const renderer = createSender(10)

    expect(() => listener({ sender: renderer.sender }, null)).not.toThrow()
    expect(() => listener({ sender: renderer.sender }, 'not-an-object')).not.toThrow()
    expect(() =>
      listener({ sender: renderer.sender }, { subscriptionId: 123, runId: 'run-1' })
    ).not.toThrow()

    expect(subscribeToPipelineRunMock).not.toHaveBeenCalled()
    expect(renderer.sender.send).not.toHaveBeenCalled()
  })

  it('reports an error frame for a malformed runId instead of throwing, addressed to the given subscriptionId', () => {
    const listener = listeners.get('pipelineRun:subscribe')
    if (!listener) {
      throw new Error('subscribe listener not registered')
    }
    const renderer = createSender(11)

    expect(() =>
      listener({ sender: renderer.sender }, { subscriptionId: 'sub-11' })
    ).not.toThrow()

    expect(subscribeToPipelineRunMock).not.toHaveBeenCalled()
    expect(renderer.sender.send).toHaveBeenCalledWith('pipelineRun:snapshot', {
      subscriptionId: 'sub-11',
      frame: { type: 'error', error: expect.any(String) }
    })
  })

  it('drops a malformed unsubscribe message instead of throwing', () => {
    const listener = listeners.get('pipelineRun:unsubscribe')
    if (!listener) {
      throw new Error('unsubscribe listener not registered')
    }
    const renderer = createSender(12)
    const hostUnsubscribe = vi.fn()
    subscribeToPipelineRunMock.mockReturnValueOnce(hostUnsubscribe)
    subscribe(renderer.sender, 'sub-12', 'run-12')

    expect(() => listener({ sender: renderer.sender }, null)).not.toThrow()
    expect(() => listener({ sender: renderer.sender }, undefined)).not.toThrow()
    expect(() => listener({ sender: renderer.sender }, { subscriptionId: 42 })).not.toThrow()

    // the live subscription from a well-formed call earlier must survive the malformed ones
    expect(hostUnsubscribe).not.toHaveBeenCalled()
  })

  it('tears down a prior subscription when the same id resubscribes', () => {
    const hostUnsubscribeA = vi.fn()
    const hostUnsubscribeB = vi.fn()
    subscribeToPipelineRunMock
      .mockReturnValueOnce(hostUnsubscribeA)
      .mockReturnValueOnce(hostUnsubscribeB)
    const renderer = createSender(5)

    subscribe(renderer.sender, 'sub-5', 'run-5')
    subscribe(renderer.sender, 'sub-5', 'run-5-again')
    expect(hostUnsubscribeA).toHaveBeenCalledOnce()
    expect(hostUnsubscribeB).not.toHaveBeenCalled()
  })
})
