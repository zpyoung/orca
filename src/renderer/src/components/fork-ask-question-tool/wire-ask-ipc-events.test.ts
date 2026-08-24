import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskRegistryEvent } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import { wireAskIpcEvents } from './wire-ask-ipc-events'

function makeEvent(overrides: Partial<AskRegistryEvent> = {}): AskRegistryEvent {
  return {
    seq: 1,
    epoch: 'epoch-a',
    askId: 'ask-1',
    paneKey: 'pane-a',
    status: 'registered',
    ...overrides
  }
}

function stubAsksApi(disposer: () => void) {
  const onSet = vi.fn<(callback: (event: AskRegistryEvent) => void) => () => void>(() => disposer)
  vi.stubGlobal('window', { api: { asks: { onSet } } })
  return onSet
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wireAskIpcEvents', () => {
  it('starts hydration and forwards each onSet event to the slice', () => {
    const onSet = stubAsksApi(vi.fn())
    const hydrateAsks = vi.fn().mockResolvedValue(undefined)
    const applyAskRegistryEvent = vi.fn()
    const store = { getState: () => ({ hydrateAsks, applyAskRegistryEvent }) }

    wireAskIpcEvents(store)

    expect(hydrateAsks).toHaveBeenCalledOnce()
    const event = makeEvent()
    onSet.mock.calls[0]?.[0]?.(event)
    expect(applyAskRegistryEvent).toHaveBeenCalledWith(event)
  })

  it('disposes via the preload-returned unsubscriber', () => {
    const disposer = vi.fn()
    stubAsksApi(disposer)
    const store = {
      getState: () => ({ hydrateAsks: vi.fn().mockResolvedValue(undefined), applyAskRegistryEvent: vi.fn() })
    }

    const dispose = wireAskIpcEvents(store)
    expect(disposer).not.toHaveBeenCalled()
    dispose()
    expect(disposer).toHaveBeenCalledOnce()
  })
})
