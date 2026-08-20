import { describe, expect, it } from 'vitest'
import { nativeChatSessionOptionDecoderForAgent } from './transcript-session-options'

// Shapes copied from real session files: a Claude assistant row stamps `effort`
// on the record and `model` inside `message`; Codex opens each turn with a
// `turn_context` row that decodes to no message at all.
const CLAUDE_ASSISTANT = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-08-19T12:00:00.000Z',
  effort: 'xhigh',
  message: { model: 'claude-opus-5', role: 'assistant', content: [] }
})
const CODEX_TURN_CONTEXT = JSON.stringify({
  type: 'turn_context',
  timestamp: '2026-08-19T12:00:00.000Z',
  payload: { turn_id: 't-1', model: 'gpt-5.6-sol', effort: 'high', summary: 'auto' }
})

function decode(agent: 'claude' | 'codex', line: string): unknown {
  return nativeChatSessionOptionDecoderForAgent(agent)?.(line) ?? null
}

describe('nativeChatSessionOptionDecoderForAgent', () => {
  it('reads model and effort off a Claude assistant row', () => {
    expect(decode('claude', CLAUDE_ASSISTANT)).toEqual({
      model: 'claude-opus-5',
      effort: 'xhigh',
      observedAt: Date.parse('2026-08-19T12:00:00.000Z')
    })
  })

  it('reads model and effort off a Codex turn_context row', () => {
    expect(decode('codex', CODEX_TURN_CONTEXT)).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
      observedAt: Date.parse('2026-08-19T12:00:00.000Z')
    })
  })

  it('ignores Claude rows generated without a model call', () => {
    const synthetic = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-19T12:00:00.000Z',
      message: { model: '<synthetic>', content: [] }
    })
    expect(decode('claude', synthetic)).toBeNull()
  })

  it('reports whichever value the row carries alone', () => {
    const effortOnly = JSON.stringify({ type: 'assistant', effort: 'high', message: {} })
    expect(decode('claude', effortOnly)).toEqual({ effort: 'high', observedAt: null })
  })

  it('skips records that name no session option', () => {
    expect(
      decode('claude', JSON.stringify({ type: 'user', message: { content: 'hi' } }))
    ).toBeNull()
    expect(
      decode('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'x' } }))
    ).toBeNull()
    expect(decode('codex', JSON.stringify({ type: 'turn_context' }))).toBeNull()
  })

  it('survives a malformed line rather than failing the read', () => {
    expect(decode('claude', '{not json')).toBeNull()
    expect(decode('codex', '')).toBeNull()
  })

  it('resolves no decoder for agents whose record shape is unsampled', () => {
    expect(nativeChatSessionOptionDecoderForAgent('grok')).toBeNull()
    expect(nativeChatSessionOptionDecoderForAgent('omp')).toBeNull()
    expect(nativeChatSessionOptionDecoderForAgent('gemini')).toBeNull()
  })

  it('decodes openclaude through the Claude shape it writes', () => {
    expect(nativeChatSessionOptionDecoderForAgent('openclaude')?.(CLAUDE_ASSISTANT)).toMatchObject({
      model: 'claude-opus-5'
    })
  })
})
