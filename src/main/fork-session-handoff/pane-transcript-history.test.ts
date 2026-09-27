import { beforeEach, describe, expect, it } from 'vitest'
import {
  getForkPaneTranscriptPaths,
  isForkSessionClaimedByOtherPane,
  recordForkPaneTranscriptObservation,
  resetForkPaneTranscriptHistory
} from './pane-transcript-history'

function observe(paneKey: string, id: string, transcriptPath?: string): void {
  recordForkPaneTranscriptObservation({
    paneKey,
    providerSession: { key: 'session_id', id, transcriptPath }
  })
}

beforeEach(() => {
  resetForkPaneTranscriptHistory()
})

describe('recordForkPaneTranscriptObservation', () => {
  it('keeps the pane’s reported paths newest first', () => {
    observe('pane-a', 'one', '/t/one.jsonl')
    observe('pane-a', 'two', '/t/two.jsonl')
    expect(getForkPaneTranscriptPaths('pane-a')).toEqual(['/t/two.jsonl', '/t/one.jsonl'])
  })

  it('promotes a repeated path instead of duplicating it', () => {
    observe('pane-a', 'one', '/t/one.jsonl')
    observe('pane-a', 'two', '/t/two.jsonl')
    observe('pane-a', 'one', '/t/one.jsonl')
    expect(getForkPaneTranscriptPaths('pane-a')).toEqual(['/t/one.jsonl', '/t/two.jsonl'])
  })

  it('caps the retained paths per pane', () => {
    for (let index = 0; index < 8; index += 1) {
      observe('pane-a', `id-${index}`, `/t/${index}.jsonl`)
    }
    expect(getForkPaneTranscriptPaths('pane-a')).toEqual([
      '/t/7.jsonl',
      '/t/6.jsonl',
      '/t/5.jsonl',
      '/t/4.jsonl',
      '/t/3.jsonl'
    ])
  })

  // A rotated session id arrives with no path of its own; the id still has to be
  // recorded so another pane's scan cannot claim the transcript behind it.
  it('records a session id reported without a transcript path', () => {
    observe('pane-a', 'rotated')
    expect(getForkPaneTranscriptPaths('pane-a')).toEqual([])
    expect(isForkSessionClaimedByOtherPane('pane-b', 'rotated')).toBe(true)
  })

  it('does not treat a pane’s own session as claimed elsewhere', () => {
    observe('pane-a', 'mine', '/t/mine.jsonl')
    expect(isForkSessionClaimedByOtherPane('pane-a', 'mine')).toBe(false)
    expect(isForkSessionClaimedByOtherPane(null, 'mine')).toBe(true)
  })

  it('ignores an event with no provider session', () => {
    recordForkPaneTranscriptObservation({ paneKey: 'pane-a', providerSession: undefined })
    expect(getForkPaneTranscriptPaths('pane-a')).toEqual([])
  })
})
