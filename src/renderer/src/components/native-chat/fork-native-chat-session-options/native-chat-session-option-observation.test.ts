import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../../../../../shared/agent-session-option-catalog'
import { nativeChatReportedValuesFromObservation } from './native-chat-session-option-observation'

// What a host probe returns for Claude: exact ids, with the seed's option menus
// carried over — including the `effort` control the pill needs.
const DISCOVERED: CatalogModel[] = [
  {
    id: 'opus[1m]',
    label: 'Opus (1M context)',
    options: [
      {
        id: 'effort',
        label: 'Effort',
        kind: { type: 'select', choices: [], defaultValue: 'high' },
        apply: {}
      }
    ]
  },
  { id: 'haiku', label: 'Haiku', options: [] }
]

function report(
  model: string | undefined,
  effort: string | undefined,
  models: CatalogModel[] = []
) {
  return nativeChatReportedValuesFromObservation({
    observation: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      observedAt: 1
    },
    agent: 'claude',
    models
  })
}

describe('nativeChatReportedValuesFromObservation', () => {
  it('maps a provider model id onto the seed family it names', () => {
    expect(report('claude-opus-5', 'xhigh')).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(report('claude-haiku-4-5-20251001', undefined)).toEqual({ model: 'haiku' })
  })

  it('prefers an exact id the host actually lists over the seed family', () => {
    expect(report('opus[1m]', 'high', DISCOVERED)).toEqual({ model: 'opus[1m]', effort: 'high' })
  })

  it('keeps an unknown model as its own selection rather than dropping it', () => {
    expect(report('company/private-tune-v2', undefined)).toEqual({
      model: 'company/private-tune-v2'
    })
  })

  it('drops an effort the resolved model has no control for', () => {
    // Seed `haiku` ships no options, so an effort value would render as an invented row.
    expect(report('claude-haiku-4-5', 'high')).toEqual({ model: 'haiku' })
  })

  it('reports nothing when the observation names no model', () => {
    // The surface keys option values by model id, so an effort alone cannot land.
    expect(report(undefined, 'max')).toBeNull()
    expect(report('   ', 'max')).toBeNull()
  })

  it('maps a Codex model id straight through, since the catalog uses the same ids', () => {
    expect(
      nativeChatReportedValuesFromObservation({
        observation: { model: 'gpt-5.6-sol', effort: 'high', observedAt: 1 },
        agent: 'codex',
        models: []
      })
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high' })
  })
})
