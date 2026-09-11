import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../api-types'

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

describe('native-chat relay preload API', () => {
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

  it('forwards relay ownership and pagination in object-form reads', async () => {
    await import('../index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi
    const args = {
      agent: 'claude' as const,
      sessionId: 'session-1',
      limit: 40,
      transcriptPath: '/remote/transcript.jsonl',
      sshConnectionId: 'ssh-1',
      beforeOffset: 8192
    }

    const readSession = api.nativeChat.readSession as unknown as (
      input: typeof args
    ) => Promise<unknown>
    await readSession(args)

    expect(invoke).toHaveBeenCalledWith('nativeChat:readSession', args)
  })

  it('preserves the positional read contract for upstream callers', async () => {
    await import('../index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi

    await api.nativeChat.readSession('codex', 'session-2', 20, '/local/transcript.jsonl')

    expect(invoke).toHaveBeenCalledWith('nativeChat:readSession', {
      agent: 'codex',
      sessionId: 'session-2',
      limit: 20,
      transcriptPath: '/local/transcript.jsonl'
    })
  })
})
