import { describe, expect, it } from 'vitest'
import { planSourceControlAgentActionLaunch } from '../source-control-agent-action-plan'

describe('source-control action launch settings', () => {
  it('keeps catalog defaults out of native draft recipe previews', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'claude',
      commandInput: 'Fix checks',
      promptDelivery: 'draft',
      detectedAgents: ['claude'],
      platform: 'darwin',
      sessionOptions: { model: 'sonnet' },
      includeSessionOptionCatalogDefaults: false
    })

    expect(result.ok && result.commandLabel).toContain("'--model' 'sonnet'")
    expect(result.ok && result.commandLabel).not.toContain('--effort')
  })
})
