import { describe, expect, it } from 'vitest'
import { EMPTY_HISTORY, pushHistory, recallNext, recallPrevious } from './agent-composer-history'

describe('history recall', () => {
  it('up-arrow on empty composer recalls the last sent input', () => {
    const history = pushHistory(EMPTY_HISTORY, 'first')
    const recall = recallPrevious(history)
    expect(recall.draft).toBe('first')
    expect(recall.history.index).toBe(0)
  })

  it('walks backward and clamps at the oldest entry', () => {
    let history = pushHistory(EMPTY_HISTORY, 'a')
    history = pushHistory(history, 'b')
    const first = recallPrevious(history)
    expect(first.draft).toBe('b')
    const second = recallPrevious(first.history)
    expect(second.draft).toBe('a')
    const third = recallPrevious(second.history)
    expect(third.draft).toBe('a') // clamped
  })

  it('down-arrow walks forward and returns to a live empty draft', () => {
    let history = pushHistory(EMPTY_HISTORY, 'a')
    history = pushHistory(history, 'b')
    const up1 = recallPrevious(history) // 'b'
    const up2 = recallPrevious(up1.history) // 'a'
    const down = recallNext(up2.history) // 'b'
    expect(down.draft).toBe('b')
    const back = recallNext(down.history) // live
    expect(back.draft).toBe('')
    expect(back.history.index).toBeNull()
  })

  it('does not record blank sends or immediate duplicates', () => {
    let history = pushHistory(EMPTY_HISTORY, '   ')
    expect(history.entries).toHaveLength(0)
    history = pushHistory(history, 'x')
    history = pushHistory(history, 'x')
    expect(history.entries).toHaveLength(1)
  })

  it('recall on empty history is a no-op', () => {
    expect(recallPrevious(EMPTY_HISTORY).draft).toBeNull()
  })
})
