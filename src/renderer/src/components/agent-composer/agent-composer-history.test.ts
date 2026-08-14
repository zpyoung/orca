import { describe, expect, it } from 'vitest'
import {
  EMPTY_HISTORY,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_TOTAL_CHARS,
  pushHistory,
  recallNext,
  recallPrevious,
  seedHistory
} from './agent-composer-history'

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

  it('evicts oldest entries first once the per-pane entry bound is exceeded', () => {
    let history = EMPTY_HISTORY
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 5; i++) {
      history = pushHistory(history, `entry-${i}`)
    }
    expect(history.entries).toHaveLength(HISTORY_MAX_ENTRIES)
    expect(history.entries[0]).toBe('entry-5')
    expect(history.entries.at(-1)).toBe(`entry-${HISTORY_MAX_ENTRIES + 4}`)
    expect(history.index).toBeNull()
  })

  it('evicts oldest entries first once the per-pane character bound is exceeded', () => {
    const chunk = 'x'.repeat(1000)
    let history = EMPTY_HISTORY
    const pushes = Math.floor(HISTORY_MAX_TOTAL_CHARS / 1000) + 5
    for (let i = 0; i < pushes; i++) {
      history = pushHistory(history, `${chunk}-${i}`)
    }
    const totalChars = history.entries.reduce((sum, entry) => sum + entry.length, 0)
    expect(totalChars).toBeLessThanOrEqual(HISTORY_MAX_TOTAL_CHARS)
    expect(history.entries.at(-1)).toBe(`${chunk}-${pushes - 1}`)
  })

  it('never evicts the entry that was just pushed, even if it alone exceeds the character bound', () => {
    const huge = 'x'.repeat(HISTORY_MAX_TOTAL_CHARS + 1000)
    let history = pushHistory(EMPTY_HISTORY, 'small')
    history = pushHistory(history, huge)
    expect(history.entries).toEqual([huge])
  })

  it('seeds recovered prompts once while preserving their order', () => {
    const initial = pushHistory(EMPTY_HISTORY, 'already sent')
    const seeded = seedHistory(initial, ['older', 'already sent', '', 'newer', 'older'])
    expect(seeded.entries).toEqual(['already sent', 'older', 'newer'])
  })

  it('returns the same state when every recovered prompt is already present', () => {
    const initial = seedHistory(EMPTY_HISTORY, ['a', 'b'])
    expect(seedHistory(initial, ['a', 'b'])).toBe(initial)
  })
})
