import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfoPaneTelemetry } from '../../shared/fork-session-info/session-info-types'
import { registerSessionInfoIpcHandlers } from './session-info-ipc'

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(channel, listener)
    })
  }
}))

describe('registerSessionInfoIpcHandlers', () => {
  const updateListeners = new Set<(telemetry: SessionInfoPaneTelemetry) => void>()
  const service = {
    getSnapshot: vi.fn(() => ({})),
    subscribe: vi.fn((listener: (telemetry: SessionInfoPaneTelemetry) => void) => {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    })
  }
  const chaining = {
    status: vi.fn(() => ({ state: 'available' as const })),
    enable: vi.fn(() => ({ state: 'chained' as const }))
  }

  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    updateListeners.clear()
    service.getSnapshot.mockClear()
    service.subscribe.mockClear()
    chaining.status.mockClear()
    chaining.enable.mockClear()
    registerSessionInfoIpcHandlers(service, chaining)
  })

  it('serves snapshots and explicit consent operations', async () => {
    expect(await handlers.get('forkSessionInfo:snapshot')?.({})).toEqual({})
    expect(await handlers.get('forkSessionInfo:chainStatus')?.({})).toEqual({
      state: 'available'
    })
    expect(await handlers.get('forkSessionInfo:enableChaining')?.({})).toEqual({
      state: 'chained'
    })
  })

  it('pushes only to the renderer that subscribed and stops after unsubscribe', () => {
    const send = vi.fn()
    const sender = { id: 7, isDestroyed: () => false, send, once: vi.fn() }
    listeners.get('forkSessionInfo:subscribe')?.({ sender })
    const telemetry = { paneKey: 'tab:leaf', provider: 'claude', updatedAt: 1 }
    for (const listener of updateListeners) {
      listener(telemetry)
    }
    expect(send).toHaveBeenCalledWith('forkSessionInfo:update', telemetry)

    listeners.get('forkSessionInfo:unsubscribe')?.({ sender })
    send.mockClear()
    for (const listener of updateListeners) {
      listener(telemetry)
    }
    expect(send).not.toHaveBeenCalled()
  })
})
