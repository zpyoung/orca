import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildForkSessionInfoApi } from './session-info-preload-api'

const { invoke, on, removeListener, send } = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn()
}))

vi.mock('electron', () => ({ ipcRenderer: { invoke, on, removeListener, send } }))

describe('buildForkSessionInfoApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the narrow snapshot and consent channels', async () => {
    invoke.mockResolvedValueOnce({}).mockResolvedValueOnce({ state: 'available' })
    const api = buildForkSessionInfoApi()
    await expect(api.getSnapshot()).resolves.toEqual({})
    await expect(api.getStatusLineChainStatus()).resolves.toEqual({ state: 'available' })
    expect(invoke).toHaveBeenNthCalledWith(1, 'forkSessionInfo:snapshot')
    expect(invoke).toHaveBeenNthCalledWith(2, 'forkSessionInfo:chainStatus')
  })

  it('subscribes and removes the exact update listener', () => {
    const api = buildForkSessionInfoApi()
    const listener = vi.fn()
    const unsubscribe = api.onUpdate(listener)
    const handler = on.mock.calls[0]?.[1]
    const telemetry = { paneKey: 'tab:leaf', provider: 'claude', updatedAt: 1 }
    handler({}, telemetry)
    expect(listener).toHaveBeenCalledWith(telemetry)
    expect(send).toHaveBeenCalledWith('forkSessionInfo:subscribe')

    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('forkSessionInfo:update', handler)
    expect(send).toHaveBeenCalledWith('forkSessionInfo:unsubscribe')
  })

  it('keeps renderer pushes subscribed until the last consumer unsubscribes', () => {
    const api = buildForkSessionInfoApi()
    const unsubscribeFirst = api.onUpdate(vi.fn())
    const unsubscribeSecond = api.onUpdate(vi.fn())

    expect(send).toHaveBeenCalledTimes(1)
    unsubscribeFirst()
    expect(send).toHaveBeenCalledTimes(1)
    unsubscribeFirst()
    expect(send).toHaveBeenCalledTimes(1)
    unsubscribeSecond()
    expect(send).toHaveBeenNthCalledWith(2, 'forkSessionInfo:unsubscribe')
  })
})
