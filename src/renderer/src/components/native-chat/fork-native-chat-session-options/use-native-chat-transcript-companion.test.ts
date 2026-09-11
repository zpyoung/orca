// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { NativeChatTurnLifecycle } from '../../../../../shared/native-chat-types'
import { useNativeChatTranscriptCompanion } from './use-native-chat-transcript-companion'

const WORKING: NativeChatTurnLifecycle = { state: 'working', turnId: 't-1', timestamp: 10 }
const COMPLETED: NativeChatTurnLifecycle = { state: 'completed', turnId: 't-1', timestamp: 20 }
const OPUS = { model: 'opus', effort: 'high', observedAt: 10 }

describe('useNativeChatTranscriptCompanion', () => {
  it('accumulates across appends that each observe only one field', () => {
    // The readers report what a batch actually read, so carrying the other field
    // forward is this store's job — see transcript-watch.test.ts.
    const { result } = renderHook(() => useNativeChatTranscriptCompanion())
    act(() => result.current[1].append({ sessionOptions: OPUS }))
    act(() => result.current[1].append({ lifecycle: COMPLETED }))
    expect(result.current[0]).toEqual({ lifecycle: COMPLETED, sessionOptions: OPUS })
  })

  it('lets a newer append win per field', () => {
    const { result } = renderHook(() => useNativeChatTranscriptCompanion())
    act(() => result.current[1].append({ lifecycle: WORKING, sessionOptions: OPUS }))
    act(() => result.current[1].append({ sessionOptions: { model: 'sonnet', observedAt: 30 } }))
    expect(result.current[0]?.lifecycle).toBe(WORKING)
    expect(result.current[0]?.sessionOptions).toEqual({ model: 'sonnet', observedAt: 30 })
  })

  it('clears a lifecycle on replace but keeps the observed options', () => {
    // A replacement re-reads a window, so a lifecycle it does not contain is gone.
    // A recorded model does not stop being true because the window moved.
    const { result } = renderHook(() => useNativeChatTranscriptCompanion())
    act(() => result.current[1].append({ lifecycle: COMPLETED, sessionOptions: OPUS }))
    act(() => result.current[1].replace(undefined))
    expect(result.current[0]?.lifecycle).toBeUndefined()
    expect(result.current[0]?.sessionOptions).toEqual(OPUS)
  })

  it('drops everything on reset, which marks a different session', () => {
    const { result } = renderHook(() => useNativeChatTranscriptCompanion())
    act(() => result.current[1].append({ lifecycle: COMPLETED, sessionOptions: OPUS }))
    act(() => result.current[1].reset())
    expect(result.current[0]).toBeUndefined()
  })

  it('ignores a pagination result that a live write already raced past', () => {
    const { result } = renderHook(() => useNativeChatTranscriptCompanion())
    const stale = result.current[1].revision()
    act(() => result.current[1].append({ lifecycle: COMPLETED }))
    act(() => result.current[1].replaceFromPagination({ lifecycle: WORKING }, stale))
    expect(result.current[0]?.lifecycle).toBe(COMPLETED)
  })
})
