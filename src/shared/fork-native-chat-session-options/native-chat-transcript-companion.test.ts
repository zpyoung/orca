import { describe, expect, it } from 'vitest'
import {
  mergeNativeChatTranscriptCompanion,
  nativeChatCompanionFrameFields,
  nativeChatCompanionFromFrame,
  retainNativeChatTranscriptCompanion
} from './native-chat-transcript-companion'
import type { NativeChatTurnLifecycle } from '../native-chat-types'

const LIFECYCLE: NativeChatTurnLifecycle = {
  state: 'completed',
  turnId: 'turn-1',
  timestamp: 10
}
const LATER_LIFECYCLE: NativeChatTurnLifecycle = {
  state: 'working',
  turnId: 'turn-2',
  timestamp: 20
}

describe('mergeNativeChatTranscriptCompanion', () => {
  it('keeps a field the newer record does not mention', () => {
    const merged = mergeNativeChatTranscriptCompanion(
      { sessionOptions: { model: 'opus', observedAt: 1 } },
      { lifecycle: LIFECYCLE }
    )
    expect(merged).toEqual({
      lifecycle: LIFECYCLE,
      sessionOptions: { model: 'opus', observedAt: 1 }
    })
  })

  it('lets the newer record win per field', () => {
    const merged = mergeNativeChatTranscriptCompanion(
      { lifecycle: LIFECYCLE, sessionOptions: { model: 'opus', observedAt: 1 } },
      { lifecycle: LATER_LIFECYCLE }
    )
    expect(merged?.lifecycle).toBe(LATER_LIFECYCLE)
    expect(merged?.sessionOptions).toEqual({ model: 'opus', observedAt: 1 })
  })

  it('collapses an empty result to undefined', () => {
    expect(mergeNativeChatTranscriptCompanion(undefined, null)).toBeUndefined()
    expect(mergeNativeChatTranscriptCompanion(undefined, {})).toBeUndefined()
  })
})

describe('retainNativeChatTranscriptCompanion', () => {
  it('keeps the already-seen value when scanning backwards into older records', () => {
    const retained = retainNativeChatTranscriptCompanion(
      { sessionOptions: { model: 'opus', observedAt: 20 } },
      { sessionOptions: { model: 'sonnet', observedAt: 10 }, lifecycle: LIFECYCLE }
    )
    // The newest observation was seen first and must not be rewound by an older row,
    // but the older row's lifecycle is still the only one seen at all.
    expect(retained?.sessionOptions).toEqual({ model: 'opus', observedAt: 20 })
    expect(retained?.lifecycle).toBe(LIFECYCLE)
  })
})

describe('nativeChatCompanionFrameFields', () => {
  it('emits the two fields as siblings, omitting what is absent', () => {
    expect(nativeChatCompanionFrameFields({ lifecycle: LIFECYCLE })).toEqual({
      lifecycle: LIFECYCLE
    })
    expect(nativeChatCompanionFrameFields(undefined)).toEqual({})
    expect('sessionOptions' in nativeChatCompanionFrameFields({ lifecycle: LIFECYCLE })).toBe(false)
  })

  it('round-trips through a frame', () => {
    const companion = { lifecycle: LIFECYCLE, sessionOptions: { effort: 'max', observedAt: 3 } }
    expect(nativeChatCompanionFromFrame(nativeChatCompanionFrameFields(companion))).toEqual(
      companion
    )
  })

  it('reads a frame that carries neither field as no companion', () => {
    expect(nativeChatCompanionFromFrame({})).toBeUndefined()
  })
})
