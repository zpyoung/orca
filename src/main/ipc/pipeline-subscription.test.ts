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
