// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewRunTailSource } from './adversarial-review-model'
import { useReviewRunTail } from './useReviewRunTail'

const EMPTY_SNAPSHOT = { runs: [] }

describe('useReviewRunTail', () => {
  it('does not read or subscribe while the panel is hidden', () => {
    const source: ReviewRunTailSource = {
      read: vi.fn().mockResolvedValue(EMPTY_SNAPSHOT),
      subscribe: vi.fn(() => vi.fn())
    }
    renderHook(() => useReviewRunTail(source, false))
    expect(source.read).not.toHaveBeenCalled()
    expect(source.subscribe).not.toHaveBeenCalled()
  })

  it('subscribes only while visible and tears down when hidden', async () => {
    const unsubscribe = vi.fn()
    const source: ReviewRunTailSource = {
      read: vi.fn().mockResolvedValue(EMPTY_SNAPSHOT),
      subscribe: vi.fn(() => unsubscribe)
    }
    const { rerender } = renderHook(({ visible }) => useReviewRunTail(source, visible), {
      initialProps: { visible: false }
    })
    rerender({ visible: true })
    await waitFor(() => expect(source.read).toHaveBeenCalledTimes(1))
    expect(source.subscribe).toHaveBeenCalledTimes(1)

    rerender({ visible: false })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
