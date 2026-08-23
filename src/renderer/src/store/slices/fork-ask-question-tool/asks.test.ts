import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AskRegistryEvent } from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { createAsksSlice, selectHeadAsk, selectPendingAskCount, type AsksSlice } from './asks'

type SnapshotResult = { asks: AskRegistryEvent[]; seq: number; epoch: string }

function createSliceStore() {
  return create<AsksSlice>()((...a) => ({
    ...createAsksSlice(...(a as unknown as Parameters<typeof createAsksSlice>))
  }))
}

function makeEvent(overrides: Partial<AskRegistryEvent> = {}): AskRegistryEvent {
  return {
    seq: 1,
    epoch: 'epoch-a',
    askId: 'ask-1',
    paneKey: 'pane-a',
    status: 'registered',
    spec: { questions: [{ id: 'q1', question: 'Continue?', type: 'confirm' }] },
    partial: {},
    ...overrides
  }
}

function successResponse(result: SnapshotResult): RuntimeRpcResponse<SnapshotResult> {
  return { id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function stubSnapshotApi(call: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { api: { runtime: { call } } })
  return call
}

function stubSnapshotResult(result: SnapshotResult) {
  return stubSnapshotApi(vi.fn().mockResolvedValue(successResponse(result)))
}

function stubDeferredSnapshot() {
  let resolve: (response: RuntimeRpcResponse<SnapshotResult>) => void = () => {}
  const promise = new Promise<RuntimeRpcResponse<SnapshotResult>>((r) => {
    resolve = r
  })
  const call = stubSnapshotApi(vi.fn().mockReturnValue(promise))
  return { call, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('asks slice', () => {
  it('starts unhydrated with no pending asks', () => {
    const store = createSliceStore()
    expect(store.getState().pendingAsksByPaneKey).toEqual({})
    expect(store.getState().askWatermark).toBeNull()
  })

  it('seeds pending asks, partials, and the watermark from ask.snapshot', async () => {
    const event = makeEvent({ partial: { q1: { confirm: true } } })
    stubSnapshotResult({ asks: [event], seq: 5, epoch: 'epoch-a' })
    const store = createSliceStore()

    await store.getState().hydrateAsks()

    expect(store.getState().pendingAsksByPaneKey['pane-a']).toEqual([
      {
        askId: 'ask-1',
        paneKey: 'pane-a',
        status: 'registered',
        spec: event.spec,
        partial: { q1: { confirm: true } },
        result: undefined
      }
    ])
    expect(store.getState().askWatermark).toEqual({ seq: 5, epoch: 'epoch-a' })
  })

  it('buffers events that arrive before hydration resolves, then applies them in order', async () => {
    const { resolve } = stubDeferredSnapshot()
    const store = createSliceStore()

    const hydration = store.getState().hydrateAsks()
    store.getState().applyAskRegistryEvent(makeEvent({ seq: 1, status: 'registered' }))
    store.getState().applyAskRegistryEvent(
      makeEvent({ seq: 2, status: 'partial', partial: { q1: { confirm: false } } })
    )

    expect(store.getState().pendingAsksByPaneKey).toEqual({})

    resolve(successResponse({ asks: [], seq: 0, epoch: 'epoch-a' }))
    await hydration

    expect(store.getState().pendingAsksByPaneKey['pane-a']?.[0]).toMatchObject({
      askId: 'ask-1',
      status: 'partial',
      partial: { q1: { confirm: false } }
    })
    expect(store.getState().askWatermark).toEqual({ seq: 2, epoch: 'epoch-a' })
  })

  it('drops an event at or below the watermark', async () => {
    stubSnapshotResult({ asks: [], seq: 5, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()

    store.getState().applyAskRegistryEvent(makeEvent({ seq: 5, status: 'answered' }))

    expect(store.getState().pendingAsksByPaneKey).toEqual({})
    expect(store.getState().askWatermark).toEqual({ seq: 5, epoch: 'epoch-a' })
  })

  it('discards the slice and re-hydrates when an event carries a different epoch', async () => {
    const call = stubSnapshotResult({ asks: [makeEvent()], seq: 1, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()
    expect(call).toHaveBeenCalledTimes(1)

    call.mockResolvedValueOnce(
      successResponse({ asks: [makeEvent({ epoch: 'epoch-b' })], seq: 1, epoch: 'epoch-b' })
    )
    store.getState().applyAskRegistryEvent(makeEvent({ epoch: 'epoch-b', seq: 99 }))

    expect(store.getState().askWatermark).toBeNull()

    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(store.getState().askWatermark).toEqual({ seq: 1, epoch: 'epoch-b' })
    expect(store.getState().pendingAsksByPaneKey['pane-a']?.[0]?.askId).toBe('ask-1')
  })

  it('keeps a pane FIFO with the first-registered ask as the head', async () => {
    stubSnapshotResult({ asks: [], seq: 0, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))
    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-2', seq: 2 }))

    expect(selectHeadAsk(store.getState(), 'pane-a')?.askId).toBe('ask-1')
    expect(store.getState().pendingAsksByPaneKey['pane-a'].map((card) => card.askId)).toEqual([
      'ask-1',
      'ask-2'
    ])
  })

  it('counts only non-terminal asks across panes for the global pending count', async () => {
    stubSnapshotResult({ asks: [], seq: 0, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', paneKey: 'pane-a', seq: 1 }))
    store.getState().applyAskRegistryEvent(
      makeEvent({ askId: 'ask-2', paneKey: 'pane-b', seq: 2, status: 'answered' })
    )

    expect(selectPendingAskCount(store.getState())).toBe(1)
  })
})
