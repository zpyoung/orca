import { describe, expect, it } from 'vitest'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../tui-agent-selection'
import type { TuiAgent } from '../types'
import {
  AGENT_FAMILIES,
  getAgentFamily,
  orderReviewerCandidates,
  TUI_AGENT_FAMILY
} from './agent-family'

describe('TUI_AGENT_FAMILY', () => {
  it('is exhaustive over every known TuiAgent and only ever returns a pinned family', () => {
    for (const agent of TUI_AGENT_AUTO_PICK_ORDER) {
      expect(AGENT_FAMILIES).toContain(getAgentFamily(agent))
    }
    expect(Object.keys(TUI_AGENT_FAMILY).sort()).toEqual([...TUI_AGENT_AUTO_PICK_ORDER].sort())
  })

  it('maps each vendor-official CLI to its own family', () => {
    expect(getAgentFamily('claude')).toBe('anthropic')
    expect(getAgentFamily('claude-agent-teams')).toBe('anthropic')
    expect(getAgentFamily('codex')).toBe('openai')
    expect(getAgentFamily('gemini')).toBe('google')
    expect(getAgentFamily('antigravity')).toBe('google')
  })

  it('falls back multi-model and third-party agents to other', () => {
    expect(getAgentFamily('opencode')).toBe('other')
    expect(getAgentFamily('cursor')).toBe('other')
    expect(getAgentFamily('grok')).toBe('other')
  })
})

describe('orderReviewerCandidates', () => {
  it('orders cross-family candidates before the author family, each in auto-pick order', () => {
    const candidates: TuiAgent[] = ['codex', 'claude', 'gemini', 'claude-agent-teams']
    expect(orderReviewerCandidates('anthropic', candidates)).toEqual([
      'codex',
      'gemini',
      'claude',
      'claude-agent-teams'
    ])
  })

  it('falls back to the author family alone when it is all that is detected+enabled', () => {
    const candidates: TuiAgent[] = ['claude-agent-teams', 'claude']
    expect(orderReviewerCandidates('anthropic', candidates)).toEqual([
      'claude',
      'claude-agent-teams'
    ])
  })

  it('drops candidates outside the detected+enabled set', () => {
    expect(orderReviewerCandidates('anthropic', ['gemini'])).toEqual(['gemini'])
  })

  it('returns nothing for an empty candidate set', () => {
    expect(orderReviewerCandidates('anthropic', [])).toEqual([])
  })
})
