import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../../shared/types'
import { COMPOSER_VERIFIED_TIER_AGENTS, resolveComposerSendTier } from './composer-send-tier'

describe('COMPOSER_VERIFIED_TIER_AGENTS', () => {
  it('contains exactly claude, openclaude, and codex', () => {
    expect([...COMPOSER_VERIFIED_TIER_AGENTS].sort()).toEqual(['claude', 'codex', 'openclaude'])
  })
})

describe('resolveComposerSendTier', () => {
  const verifiedAgents: TuiAgent[] = ['claude', 'openclaude', 'codex']

  for (const agent of verifiedAgents) {
    it(`resolves ${agent} to verified when wrap markers are reliable`, () => {
      expect(resolveComposerSendTier(agent, { isLocalConptyBelowWrapMarkers: false })).toBe(
        'verified'
      )
    })

    it(`demotes ${agent} to input when local ConPTY lacks reliable wrap markers`, () => {
      expect(resolveComposerSendTier(agent, { isLocalConptyBelowWrapMarkers: true })).toBe(
        'input'
      )
    })
  }

  const nonVerifiedAgents: TuiAgent[] = ['gemini', 'aider', 'cursor', 'copilot', 'devin']

  for (const agent of nonVerifiedAgents) {
    it(`resolves non-allowlisted agent ${agent} to input regardless of wrap markers`, () => {
      expect(resolveComposerSendTier(agent, { isLocalConptyBelowWrapMarkers: false })).toBe(
        'input'
      )
      expect(resolveComposerSendTier(agent, { isLocalConptyBelowWrapMarkers: true })).toBe(
        'input'
      )
    })
  }

  it('resolves grok (card-tier) to input despite being NATIVE_CHAT_SUPPORTED_AGENTS', () => {
    expect(resolveComposerSendTier('grok', { isLocalConptyBelowWrapMarkers: false })).toBe(
      'input'
    )
    expect(resolveComposerSendTier('grok', { isLocalConptyBelowWrapMarkers: true })).toBe('input')
  })

  it('resolves omp (card-tier) to input despite being NATIVE_CHAT_SUPPORTED_AGENTS', () => {
    expect(resolveComposerSendTier('omp', { isLocalConptyBelowWrapMarkers: false })).toBe('input')
    expect(resolveComposerSendTier('omp', { isLocalConptyBelowWrapMarkers: true })).toBe('input')
  })
})
