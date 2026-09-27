import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../api-types'
import type { AskRegistryEvent } from '../../shared/fork-ask-question-tool/ask-question-schema'

const { exposeInMainWorld, invoke, on, removeListener, send, sendSync } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

describe('ask registry preload API', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')

  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockReset()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
    send.mockReset()
    sendSync.mockReset()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', { addEventListener: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalContextIsolated) {
      Object.defineProperty(process, 'contextIsolated', originalContextIsolated)
    } else {
      Reflect.deleteProperty(process, 'contextIsolated')
    }
  })

  it('onSet registers on ask:set and forwards the event to the caller', async () => {
    await import('../index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi

    const received: AskRegistryEvent[] = []
    api.asks.onSet((event) => received.push(event))

    expect(on).toHaveBeenCalledWith('ask:set', expect.any(Function))
    const [, registeredListener] = on.mock.calls.find(([channel]) => channel === 'ask:set')!

    const event: AskRegistryEvent = {
      seq: 1,
      epoch: 'epoch-1',
      askId: 'ask-1',
      paneKey: 'pane-1',
      status: 'registered'
    }
    registeredListener({}, event)

    expect(received).toEqual([event])
  })

  it('disposer removes the exact listener instance registered by onSet', async () => {
    await import('../index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi

    const dispose = api.asks.onSet(() => {})
    const [, registeredListener] = on.mock.calls.find(([channel]) => channel === 'ask:set')!

    dispose()

    // a disposer that removes a *different* function reference silently leaks the listener
    expect(removeListener).toHaveBeenCalledWith('ask:set', registeredListener)
  })
})
