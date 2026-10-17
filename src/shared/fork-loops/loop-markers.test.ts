import { describe, expect, it } from 'vitest'
import { parseLoopMarkers } from './loop-markers'
import { LOOP_PREAMBLE } from './loop-prompt'

describe('parseLoopMarkers', () => {
  it('matches a marker after a TUI glyph', () => {
    expect(parseLoopMarkers('⏺ LOOP_DONE')).toEqual([{ kind: 'done' }])
  })

  it('matches a decide marker with text after leading whitespace', () => {
    expect(parseLoopMarkers('  LOOP_DECIDE: pick a db')).toEqual([
      { kind: 'decide', text: 'pick a db' }
    ])
  })

  it('matches blocked with a reason', () => {
    expect(parseLoopMarkers('LOOP_BLOCKED: missing token')).toEqual([
      { kind: 'blocked', text: 'missing token' }
    ])
  })

  it('ignores bare words and markers embedded in prose', () => {
    expect(parseLoopMarkers('Done')).toEqual([])
    expect(parseLoopMarkers('the LOOP_DONE marker')).toEqual([])
  })

  it('rejects text longer than 500 characters after the colon', () => {
    expect(parseLoopMarkers(`LOOP_BLOCKED: ${'x'.repeat(501)}`)).toEqual([])
    expect(parseLoopMarkers(`LOOP_BLOCKED: ${'x'.repeat(500)}`)).toHaveLength(1)
  })

  it('returns markers in order of appearance across lines', () => {
    const text = 'working\r\nLOOP_DECIDE: a or b\nmore\n● LOOP_DONE\n'
    expect(parseLoopMarkers(text)).toEqual([{ kind: 'decide', text: 'a or b' }, { kind: 'done' }])
  })

  it('ignores ANSI color around a marker', () => {
    expect(parseLoopMarkers('\u001b[32mLOOP_DONE\u001b[0m')).toEqual([{ kind: 'done' }])
  })

  it('never matches the preamble echo', () => {
    expect(parseLoopMarkers(LOOP_PREAMBLE)).toEqual([])
  })
})
