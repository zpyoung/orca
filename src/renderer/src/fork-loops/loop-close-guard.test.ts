import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { LoopSnapshot } from '../../../shared/fork-loops/loop-types'
import { cancelLoopClose, guardLoopTerminalClose, resolveLoopCloseChoice } from './loop-close-guard'

const initialState = useAppStore.getInitialState()

function makeLoop(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture supplies only the fields the guard reads.
  return {
    id: 'l1',
    worktreeId: 'wt-1',
    name: 'loop',
    state: 'running',
    tab: { tabId: 'tab-1', paneKey: 'tab-1:1' },
    ...overrides
  } as LoopSnapshot
}

function seedLoop(loop: LoopSnapshot): void {
  useAppStore.getState().applyLoopSnapshot(loop)
}

const detach = vi.fn()
const stop = vi.fn()

beforeEach(() => {
  useAppStore.setState({ ...initialState }, true)
  detach.mockReset().mockResolvedValue(undefined)
  stop.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { loops: { detach, stop } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('guardLoopTerminalClose', () => {
  it('lets a tab without a loop close', () => {
    const reenter = vi.fn()
    expect(guardLoopTerminalClose('tab-1', undefined, reenter)).toBe(false)
    expect(useAppStore.getState().loopCloseConfirm).toBeNull()
  })

  it.each(['completed', 'stopped', 'paused'] as const)('lets a %s loop close', (state) => {
    seedLoop(makeLoop({ state }))
    expect(guardLoopTerminalClose('tab-1', undefined, vi.fn())).toBe(false)
    expect(useAppStore.getState().loopCloseConfirm).toBeNull()
  })

  it('ignores a loop bound to another tab', () => {
    seedLoop(makeLoop({ tab: { tabId: 'tab-2', paneKey: 'tab-2:1' } }))
    expect(guardLoopTerminalClose('tab-1', undefined, vi.fn())).toBe(false)
  })

  it.each([
    ['pty-exit', { reason: 'pty-exit' as const }],
    ['force', { force: true }],
    ['a lifecycle close', { lifecyclePtyId: 'pty-1' }],
    ['a bulk close', { skipRunningProcessConfirm: true }]
  ])('does not prompt for %s', (_label, options) => {
    seedLoop(makeLoop())
    expect(guardLoopTerminalClose('tab-1', options, vi.fn())).toBe(false)
    expect(useAppStore.getState().loopCloseConfirm).toBeNull()
  })

  it.each(['running', 'needs-you'] as const)('takes over the close of a %s loop', (state) => {
    seedLoop(makeLoop({ state }))
    const reenter = vi.fn()

    expect(guardLoopTerminalClose('tab-1', undefined, reenter)).toBe(true)

    expect(useAppStore.getState().loopCloseConfirm).toMatchObject({
      loopId: 'l1',
      tabId: 'tab-1'
    })
    expect(reenter).not.toHaveBeenCalled()
  })

  it('detaches the loop on "Keep running" and then re-enters the close', async () => {
    seedLoop(makeLoop())
    const reenter = vi.fn()
    guardLoopTerminalClose('tab-1', undefined, reenter)

    await resolveLoopCloseChoice('keep-running')

    expect(detach).toHaveBeenCalledWith('l1')
    expect(stop).not.toHaveBeenCalled()
    expect(reenter).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().loopCloseConfirm).toBeNull()
  })

  it('stops the loop now on "Stop loop" and then re-enters the close', async () => {
    seedLoop(makeLoop())
    const reenter = vi.fn()
    guardLoopTerminalClose('tab-1', undefined, reenter)

    await resolveLoopCloseChoice('stop')

    expect(stop).toHaveBeenCalledWith('l1', 'now')
    expect(detach).not.toHaveBeenCalled()
    expect(reenter).toHaveBeenCalledTimes(1)
  })

  it('keeps the tab open when the loop action fails', async () => {
    seedLoop(makeLoop())
    const reenter = vi.fn()
    const onCancel = vi.fn()
    detach.mockRejectedValue(new Error('boom'))
    guardLoopTerminalClose('tab-1', { onCancel }, reenter)

    await resolveLoopCloseChoice('keep-running')

    expect(reenter).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().loopCloseConfirm).toBeNull()
  })

  it('reports a dismissed dialog through onCancel without closing', () => {
    seedLoop(makeLoop())
    const reenter = vi.fn()
    const onCancel = vi.fn()
    guardLoopTerminalClose('tab-1', { onCancel }, reenter)

    cancelLoopClose()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(reenter).not.toHaveBeenCalled()
    expect(useAppStore.getState().loopCloseConfirm).toBeNull()
  })

  it('tolerates a store double without loop state', () => {
    const getState = vi.spyOn(useAppStore, 'getState').mockReturnValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double like the terminal-tab-actions suites use.
      {} as ReturnType<typeof useAppStore.getState>
    )
    try {
      expect(guardLoopTerminalClose('tab-1', undefined, vi.fn())).toBe(false)
    } finally {
      getState.mockRestore()
    }
  })
})
