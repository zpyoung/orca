import { describe, expect, it, vi } from 'vitest'
import type { LoopSnapshot } from '../../../shared/fork-loops/loop-types'
import { createTestStore } from '../store/slices/store-test-helpers'
import { selectLoopForPaneKey, selectLoopsForWorktree } from './loops-slice'

function makeLoop(overrides: Partial<LoopSnapshot> & { id: string }): LoopSnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture supplies only the fields the slice reads.
  return {
    worktreeId: 'wt-1',
    name: 'loop',
    state: 'running',
    ...overrides
  } as LoopSnapshot
}

describe('loops slice', () => {
  it('indexes a snapshot by id and by pane key', () => {
    const store = createTestStore()
    store
      .getState()
      .applyLoopSnapshot(makeLoop({ id: 'l1', tab: { tabId: 't1', paneKey: 't1:1' } }))

    expect(store.getState().loopsById.l1.id).toBe('l1')
    expect(store.getState().loopIdByPaneKey).toEqual({ 't1:1': 'l1' })
    expect(selectLoopForPaneKey(store.getState(), 't1:1')?.id).toBe('l1')
    expect(selectLoopForPaneKey(store.getState(), 'missing')).toBeUndefined()
  })

  it('drops the pane mapping when the tab is cleared', () => {
    const store = createTestStore()
    store
      .getState()
      .applyLoopSnapshot(makeLoop({ id: 'l1', tab: { tabId: 't1', paneKey: 't1:1' } }))
    store.getState().applyLoopSnapshot(makeLoop({ id: 'l1', state: 'paused' }))

    expect(store.getState().loopsById.l1.state).toBe('paused')
    expect(store.getState().loopIdByPaneKey).toEqual({})
  })

  it('moves the pane mapping when the loop rebinds to another pane', () => {
    const store = createTestStore()
    store
      .getState()
      .applyLoopSnapshot(makeLoop({ id: 'l1', tab: { tabId: 't1', paneKey: 't1:1' } }))
    store
      .getState()
      .applyLoopSnapshot(makeLoop({ id: 'l1', tab: { tabId: 't2', paneKey: 't2:1' } }))

    expect(store.getState().loopIdByPaneKey).toEqual({ 't2:1': 'l1' })
  })

  it('lists loops for one worktree and keeps the result stable between reads', () => {
    const store = createTestStore()
    store.getState().applyLoopSnapshot(makeLoop({ id: 'l1', worktreeId: 'wt-1' }))
    store.getState().applyLoopSnapshot(makeLoop({ id: 'l2', worktreeId: 'wt-2' }))

    const first = selectLoopsForWorktree(store.getState(), 'wt-1')
    expect(first.map((loop) => loop.id)).toEqual(['l1'])
    expect(selectLoopsForWorktree(store.getState(), 'wt-1')).toBe(first)
  })

  it('hydrates both maps from the list call', async () => {
    const list = vi
      .fn()
      .mockResolvedValue([
        makeLoop({ id: 'l1', tab: { tabId: 't1', paneKey: 't1:1' } }),
        makeLoop({ id: 'l2' })
      ])
    vi.stubGlobal('window', { api: { loops: { list } } })
    try {
      const store = createTestStore()
      await store.getState().hydrateLoops()

      expect(Object.keys(store.getState().loopsById).sort()).toEqual(['l1', 'l2'])
      expect(store.getState().loopIdByPaneKey).toEqual({ 't1:1': 'l1' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens and closes the setup dialog', () => {
    const store = createTestStore()
    expect(store.getState().loopSetupDialog).toEqual({ open: false })

    store.getState().openLoopSetup({ worktreeId: 'wt-1', groupId: 'g-1' })
    expect(store.getState().loopSetupDialog).toEqual({
      open: true,
      worktreeId: 'wt-1',
      groupId: 'g-1'
    })

    store.getState().closeLoopSetup()
    expect(store.getState().loopSetupDialog).toEqual({ open: false })
  })

  it('runs onDone once when the close confirmation resolves', () => {
    const store = createTestStore()
    const onDone = vi.fn()
    store.getState().requestLoopCloseConfirm({ loopId: 'l1', tabId: 't1', onDone })
    expect(store.getState().loopCloseConfirm?.loopId).toBe('l1')
    expect(onDone).not.toHaveBeenCalled()

    store.getState().resolveLoopCloseConfirm()
    expect(store.getState().loopCloseConfirm).toBeNull()
    expect(onDone).toHaveBeenCalledTimes(1)

    store.getState().resolveLoopCloseConfirm()
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
