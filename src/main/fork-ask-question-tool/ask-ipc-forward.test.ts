import { describe, it, expect, vi } from 'vitest'
import { forwardAskEventsToRenderer } from './ask-ipc-forward'
import type { AskRegistry } from './ask-registry'
import type { AskRegistryEvent } from '../../shared/fork-ask-question-tool/ask-question-schema'

function fakeWindow() {
  return { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } }
}

function fakeRegistry() {
  const listeners = new Set<(event: AskRegistryEvent) => void>()
  const registry: Pick<AskRegistry, 'onAskChanged'> = {
    onAskChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
  }
  return { registry, emit: (event: AskRegistryEvent) => listeners.forEach((l) => l(event)) }
}

const event: AskRegistryEvent = {
  seq: 1,
  epoch: 'epoch-1',
  askId: 'ask-1',
  paneKey: 'pane-1',
  status: 'registered'
}

describe('forwardAskEventsToRenderer', () => {
  it('sends a registry event to both the main window and the popout window', () => {
    const main = fakeWindow()
    const popout = fakeWindow()
    const { registry, emit } = fakeRegistry()

    forwardAskEventsToRenderer(
      registry as AskRegistry,
      () => main as unknown as Electron.BrowserWindow,
      () => popout as unknown as Electron.BrowserWindow
    )
    emit(event)

    expect(main.webContents.send).toHaveBeenCalledWith('ask:set', event)
    expect(popout.webContents.send).toHaveBeenCalledWith('ask:set', event)
  })

  it('sends nothing when the main window is destroyed', () => {
    const main = fakeWindow()
    main.isDestroyed.mockReturnValue(true)
    const popout = fakeWindow()
    const { registry, emit } = fakeRegistry()

    forwardAskEventsToRenderer(
      registry as AskRegistry,
      () => main as unknown as Electron.BrowserWindow,
      () => popout as unknown as Electron.BrowserWindow
    )
    emit(event)

    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(popout.webContents.send).not.toHaveBeenCalled()
  })

  it('sends nothing after the returned unsubscribe is called', () => {
    const main = fakeWindow()
    const popout = fakeWindow()
    const { registry, emit } = fakeRegistry()

    const unsubscribe = forwardAskEventsToRenderer(
      registry as AskRegistry,
      () => main as unknown as Electron.BrowserWindow,
      () => popout as unknown as Electron.BrowserWindow
    )
    unsubscribe()
    emit(event)

    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(popout.webContents.send).not.toHaveBeenCalled()
  })
})
