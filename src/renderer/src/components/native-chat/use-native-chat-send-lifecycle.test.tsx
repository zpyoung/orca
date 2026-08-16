// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'

function handle(settleAfterMs = 500) {
  return { cancel: vi.fn<() => void>(), settleAfterMs }
}

describe('useNativeChatSendLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels owned writes when the PTY target changes and when the composer unmounts', () => {
    vi.useFakeTimers()
    const first = handle()
    const second = handle()
    const onPendingSendCanceled = vi.fn()
    const { result, rerender, unmount } = renderHook(
      ({ targetPtyId }) => useNativeChatSendLifecycle('tab-1', targetPtyId, onPendingSendCanceled),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.trackPendingSend(first, 'pending-1'))
    rerender({ targetPtyId: 'pty-2' })
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-1')

    act(() => result.current.trackPendingSend(second, 'pending-2'))
    unmount()
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-2')
  })

  it('cancels every remaining handle even when an earlier cancel throws (r5-2)', () => {
    vi.useFakeTimers()
    const first = handle()
    first.cancel.mockImplementation(() => {
      throw new Error('preload write dead')
    })
    const second = handle()
    const onPendingSendCanceled = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatSendLifecycle('tab-1', 'pty-1', onPendingSendCanceled)
    )

    act(() => result.current.trackPendingSend(first, 'pending-1'))
    act(() => result.current.trackPendingSend(second, 'pending-2'))
    act(() => result.current.cancelPendingSends())

    expect(first.cancel).toHaveBeenCalledOnce()
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-1')
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-2')

    // The map must still be cleared so a later cancel does not revisit either.
    act(() => result.current.cancelPendingSends())
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(second.cancel).toHaveBeenCalledOnce()
  })

  it('cancels pending writes immediately on interrupt without double-cancelling', () => {
    vi.useFakeTimers()
    const pending = handle()
    const onPendingSendCanceled = vi.fn()
    const { result, unmount } = renderHook(() =>
      useNativeChatSendLifecycle('tab-1', 'pty-1', onPendingSendCanceled)
    )

    act(() => result.current.trackPendingSend(pending, 'pending-1'))
    act(() => result.current.cancelPendingSends())
    expect(pending.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-1')

    unmount()
    expect(pending.cancel).toHaveBeenCalledOnce()
  })

  it('drops settled handles so a later interrupt does not revisit completed sends', () => {
    vi.useFakeTimers()
    const settled = handle(800)
    const onPendingSendCanceled = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatSendLifecycle('tab-1', 'pty-1', onPendingSendCanceled)
    )

    act(() => result.current.trackPendingSend(settled, 'pending-1'))
    act(() => vi.advanceTimersByTime(settled.settleAfterMs))
    act(() => result.current.cancelPendingSends())

    expect(settled.cancel).not.toHaveBeenCalled()
    expect(onPendingSendCanceled).not.toHaveBeenCalled()
  })

  it('cancels a pending send when the same pty turns transport-unsafe', () => {
    vi.useFakeTimers()
    const pending = handle()
    const onPendingSendCanceled = vi.fn()
    const { result, rerender } = renderHook(
      ({ transportSafe }) =>
        useNativeChatSendLifecycle('tab-1', 'pty-1', onPendingSendCanceled, transportSafe),
      { initialProps: { transportSafe: true } }
    )

    act(() => result.current.trackPendingSend(pending, 'pending-1'))
    rerender({ transportSafe: false })

    expect(pending.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledExactlyOnceWith('pending-1')
  })

  it('does not cancel a pending send when transportSafe is unset (default true)', () => {
    vi.useFakeTimers()
    const pending = handle()
    const onPendingSendCanceled = vi.fn()
    const { result, rerender } = renderHook(
      () => useNativeChatSendLifecycle('tab-1', 'pty-1', onPendingSendCanceled),
      { initialProps: {} }
    )

    act(() => result.current.trackPendingSend(pending, 'pending-1'))
    rerender({})

    expect(pending.cancel).not.toHaveBeenCalled()
  })

  it('keeps a renderer-stalled send cancelable past its nominal schedule', async () => {
    vi.useFakeTimers()
    let resolveSettled!: () => void
    const stalled = {
      ...handle(640),
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve
      })
    }
    const onPendingSendCanceled = vi.fn()
    const { result, rerender } = renderHook(
      ({ targetPtyId }) => useNativeChatSendLifecycle('tab-1', targetPtyId, onPendingSendCanceled),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.trackPendingSend(stalled, 'pending-1'))
    act(() => vi.advanceTimersByTime(stalled.settleAfterMs + 1_000))
    rerender({ targetPtyId: 'pty-2' })

    expect(stalled.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-1')
    await act(async () => {
      resolveSettled()
    })
  })
})
