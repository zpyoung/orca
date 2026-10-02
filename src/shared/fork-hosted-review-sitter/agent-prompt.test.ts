import { describe, expect, it } from 'vitest'
import { buildHostedReviewAgentPrompt } from './agent-prompt'
import type { RepeatedOwnFixEvidence } from './stop-policy'

describe('hosted review agent prompt repeated-failure context', () => {
  it('lists every earlier publish attempt for the same failure group', () => {
    const previousFixAttempts: readonly RepeatedOwnFixEvidence[] = [
      {
        publishActionId: 'publish-attempt-1',
        checkKey: 'lint',
        failureSignature: 'failure:formatting',
        sourceHeadSha: 'source-head-1',
        producedHeadSha: 'produced-head-1'
      },
      {
        publishActionId: 'publish-attempt-2',
        checkKey: 'lint',
        failureSignature: 'failure:formatting',
        sourceHeadSha: 'source-head-2',
        producedHeadSha: 'produced-head-2'
      }
    ]

    const prompt = buildHostedReviewAgentPrompt({
      task: 'fix-checks',
      basePrompt: '{"checkKey":"lint"}',
      reviewUrl: 'https://github.com/acme/repo/pull/42',
      expectedHeadSha: 'head-3',
      unattended: true,
      preparationAttemptFingerprint: 'prepare-head-3',
      previousFixAttempts
    })

    expect(prompt).toContain('https://github.com/acme/repo/pull/42')
    expect(prompt).toContain('head-3')
    expect(prompt).toContain(JSON.stringify(previousFixAttempts, null, 2))
  })
})
