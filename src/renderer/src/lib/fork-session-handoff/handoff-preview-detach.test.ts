import { describe, expect, it } from 'vitest'
import {
  INITIAL_HANDOFF_PREVIEW_PHASE,
  reduceHandoffPreview,
  type HandoffPreviewEvent,
  type HandoffPreviewPhase
} from './handoff-preview-detach'

const automaticEvents: HandoffPreviewEvent[] = [
  { type: 'controls-changed' },
  { type: 'target-changed' },
  { type: 'observed-idle' }
]

const allEvents: HandoffPreviewEvent[] = [
  { type: 'user-edit' },
  { type: 'regenerate' },
  ...automaticEvents,
  { type: 'rescan-completed' }
]

describe('reduceHandoffPreview', () => {
  it('detaches on every user edit without discarding existing reasons', () => {
    expect(reduceHandoffPreview(INITIAL_HANDOFF_PREVIEW_PHASE, { type: 'user-edit' })).toEqual({
      state: { phase: 'detached', staleReasons: [] },
      effect: 'none'
    })

    const detached: HandoffPreviewPhase = {
      phase: 'detached',
      staleReasons: ['target-changed']
    }
    expect(reduceHandoffPreview(detached, { type: 'user-edit' })).toEqual({
      state: detached,
      effect: 'none'
    })
  })

  it.each(automaticEvents)('recomposes attached text for $type', (event) => {
    expect(reduceHandoffPreview({ phase: 'attached' }, event)).toEqual({
      state: { phase: 'attached' },
      effect: 'recompose'
    })
  })

  it('updates scan warnings without changing attached text', () => {
    expect(reduceHandoffPreview({ phase: 'attached' }, { type: 'rescan-completed' })).toEqual({
      state: { phase: 'attached' },
      effect: 'none'
    })
  })

  it.each([
    ['controls-changed', 'controls-changed'],
    ['target-changed', 'target-changed'],
    ['observed-idle', 'newer-session-context'],
    ['rescan-completed', 'rescan-completed']
  ] as const)('records an ordered notice for detached %s', (eventType, reason) => {
    const state: HandoffPreviewPhase = {
      phase: 'detached',
      staleReasons: ['target-changed']
    }
    const transition = reduceHandoffPreview(state, { type: eventType })

    expect(transition.effect).toBe('notice')
    expect(transition.state).toEqual({
      phase: 'detached',
      staleReasons: reason === 'target-changed' ? ['target-changed'] : ['target-changed', reason]
    })
  })

  it('de-duplicates stale reasons in first-observed order', () => {
    let state: HandoffPreviewPhase = { phase: 'detached', staleReasons: [] }
    for (const event of [
      { type: 'target-changed' },
      { type: 'controls-changed' },
      { type: 'target-changed' },
      { type: 'observed-idle' }
    ] as const) {
      state = reduceHandoffPreview(state, event).state
    }

    expect(state).toEqual({
      phase: 'detached',
      staleReasons: ['target-changed', 'controls-changed', 'newer-session-context']
    })
  })

  it('allows only regenerate to recompose while detached', () => {
    const detached: HandoffPreviewPhase = {
      phase: 'detached',
      staleReasons: ['controls-changed']
    }
    const effects = allEvents.map((event) => [
      event.type,
      reduceHandoffPreview(detached, event).effect
    ])

    expect(effects).toEqual([
      ['user-edit', 'none'],
      ['regenerate', 'recompose'],
      ['controls-changed', 'notice'],
      ['target-changed', 'notice'],
      ['observed-idle', 'notice'],
      ['rescan-completed', 'notice']
    ])
    expect(reduceHandoffPreview(detached, { type: 'regenerate' }).state).toEqual({
      phase: 'attached'
    })
  })

  it('treats an explicit regenerate as a recompose in either phase', () => {
    expect(reduceHandoffPreview({ phase: 'attached' }, { type: 'regenerate' })).toEqual({
      state: { phase: 'attached' },
      effect: 'recompose'
    })
  })
})
