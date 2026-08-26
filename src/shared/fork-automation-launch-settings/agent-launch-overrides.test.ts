import { describe, expect, it } from 'vitest'
import {
  agentLaunchOverridesToSessionOptionValues,
  describeOverriddenOptionIds,
  isEmptyAgentLaunchOverrides,
  normalizeAgentLaunchOverrides,
  resolveAgentLaunchOverrides
} from './agent-launch-overrides'

type CatalogCase = {
  agent: 'claude' | 'codex'
  model: string
  modelArgs: string[]
  effortArgs: string[]
  rawEffort: string
  rawEffortTokens: string[]
  rawModel: string
  rawModelTokens: string[]
  unknownModel: string
}

const CATALOG_CASES: CatalogCase[] = [
  {
    agent: 'claude',
    model: 'sonnet',
    modelArgs: ['--model', 'sonnet'],
    effortArgs: ['--effort', 'high'],
    rawEffort: '--effort low',
    rawEffortTokens: ['--effort', 'low'],
    rawModel: '--model haiku',
    rawModelTokens: ['--model', 'haiku'],
    unknownModel: 'claude-fable-5'
  },
  {
    agent: 'codex',
    model: 'gpt-5.5',
    modelArgs: ['-m', 'gpt-5.5'],
    effortArgs: ['-c', 'model_reasoning_effort=high'],
    rawEffort: '-c model_reasoning_effort=low',
    rawEffortTokens: ['-c', 'model_reasoning_effort=low'],
    rawModel: '-m gpt-5.6-luna',
    rawModelTokens: ['-m', 'gpt-5.6-luna'],
    unknownModel: 'gpt-future-codex'
  }
]

describe.each(CATALOG_CASES)('resolveAgentLaunchOverrides ($agent)', (catalogCase) => {
  it('emits only raw arguments without an explicit model', () => {
    expect(
      resolveAgentLaunchOverrides(catalogCase.agent, {
        optionValues: { effort: 'high' },
        agentArgs: '--verbose'
      })
    ).toEqual({ args: ['--verbose'], applied: {} })
  })

  it('emits an explicit model without catalog defaults', () => {
    expect(resolveAgentLaunchOverrides(catalogCase.agent, { model: catalogCase.model })).toEqual({
      args: catalogCase.modelArgs,
      applied: { model: catalogCase.model }
    })
  })

  it('emits explicit model options', () => {
    expect(
      resolveAgentLaunchOverrides(catalogCase.agent, {
        model: catalogCase.model,
        optionValues: { effort: 'high' }
      })
    ).toEqual({
      args: [...catalogCase.modelArgs, ...catalogCase.effortArgs],
      applied: { model: catalogCase.model, effort: 'high' }
    })
  })

  it('appends a shadowing effort argument and drops its applied value', () => {
    expect(
      resolveAgentLaunchOverrides(catalogCase.agent, {
        model: catalogCase.model,
        optionValues: { effort: 'high' },
        agentArgs: catalogCase.rawEffort
      })
    ).toEqual({
      args: [...catalogCase.modelArgs, ...catalogCase.effortArgs, ...catalogCase.rawEffortTokens],
      applied: { model: catalogCase.model }
    })
  })

  it('appends a shadowing model argument and drops every applied value', () => {
    expect(
      resolveAgentLaunchOverrides(catalogCase.agent, {
        model: catalogCase.model,
        optionValues: { effort: 'high' },
        agentArgs: catalogCase.rawModel
      })
    ).toEqual({
      args: [...catalogCase.modelArgs, ...catalogCase.effortArgs, ...catalogCase.rawModelTokens],
      applied: {}
    })
  })

  it('passes opaque model ids through unknown-model options', () => {
    expect(
      resolveAgentLaunchOverrides(catalogCase.agent, {
        model: catalogCase.unknownModel,
        optionValues: { effort: 'high' }
      })
    ).toEqual({
      args: [
        ...catalogCase.modelArgs.slice(0, -1),
        catalogCase.unknownModel,
        ...catalogCase.effortArgs
      ],
      applied: { model: catalogCase.unknownModel, effort: 'high' }
    })
  })

  it('keeps option values inert while the model is unset', () => {
    expect(
      resolveAgentLaunchOverrides(catalogCase.agent, { optionValues: { effort: 'high' } })
    ).toEqual({ args: [], applied: {} })
  })
})

describe('resolveAgentLaunchOverrides edge cases', () => {
  it('emits only raw arguments for an uncataloged agent', () => {
    expect(
      resolveAgentLaunchOverrides('amp', {
        model: 'anything',
        optionValues: { effort: 'high' },
        agentArgs: '--profile nightly'
      })
    ).toEqual({ args: ['--profile', 'nightly'], applied: {} })
  })

  it('drops invalid unknown-model select values', () => {
    expect(
      resolveAgentLaunchOverrides('codex', {
        model: 'gpt-future-codex',
        optionValues: { effort: 'impossible' }
      })
    ).toEqual({
      args: ['-m', 'gpt-future-codex'],
      applied: { model: 'gpt-future-codex' }
    })
  })

  it('keeps structured values but claims no raw shadow after tokenizer failure', () => {
    const overrides = {
      model: 'sonnet',
      optionValues: { effort: 'high' },
      agentArgs: "--effort 'low"
    }
    expect(resolveAgentLaunchOverrides('claude', overrides)).toEqual({
      args: ['--model', 'sonnet', '--effort', 'high'],
      applied: { model: 'sonnet', effort: 'high' }
    })
    expect(describeOverriddenOptionIds('claude', overrides)).toEqual([])
  })
})

describe('describeOverriddenOptionIds', () => {
  it('describes model and option shadowing', () => {
    expect(
      describeOverriddenOptionIds('claude', {
        model: 'sonnet',
        agentArgs: '--model haiku --effort low'
      })
    ).toEqual(['model', 'effort'])
    expect(
      describeOverriddenOptionIds('codex', {
        model: 'gpt-5.5',
        agentArgs: '--model gpt-5.6-luna -c model_reasoning_effort=low'
      })
    ).toEqual(['model', 'effort'])
  })

  it('ignores apparent options after the argument terminator', () => {
    expect(
      describeOverriddenOptionIds('claude', {
        model: 'sonnet',
        agentArgs: '-- --model haiku --effort low'
      })
    ).toEqual([])
  })

  it('returns no ids for empty arguments or an uncataloged agent', () => {
    expect(describeOverriddenOptionIds('claude', { model: 'sonnet' })).toEqual([])
    expect(
      describeOverriddenOptionIds('amp', { model: 'anything', agentArgs: '--model other' })
    ).toEqual([])
  })
})

describe('agentLaunchOverridesToSessionOptionValues', () => {
  it('requires an explicit nonblank model', () => {
    expect(agentLaunchOverridesToSessionOptionValues(undefined)).toBeUndefined()
    expect(agentLaunchOverridesToSessionOptionValues({})).toBeUndefined()
    expect(
      agentLaunchOverridesToSessionOptionValues({ optionValues: { effort: 'high' } })
    ).toBeUndefined()
  })

  it('merges valid option values under the authoritative model', () => {
    expect(
      agentLaunchOverridesToSessionOptionValues({
        model: ' sonnet ',
        optionValues: { effort: 'high', fastMode: true, model: false }
      })
    ).toEqual({ effort: 'high', fastMode: true, model: 'sonnet' })
  })
})

describe('normalizeAgentLaunchOverrides', () => {
  it('rejects non-record values and collapses empty values', () => {
    for (const value of [undefined, null, true, 'value', [], {}, { agentArgs: '  ' }]) {
      expect(normalizeAgentLaunchOverrides(value)).toBeUndefined()
    }
  })

  it('keeps valid fields and ignores unknown siblings', () => {
    expect(
      normalizeAgentLaunchOverrides({
        model: ' sonnet ',
        optionValues: { effort: 'high', fastMode: false, count: 3 },
        agentArgs: '  --verbose  ',
        futureField: true
      })
    ).toEqual({
      model: 'sonnet',
      optionValues: { effort: 'high', fastMode: false },
      agentArgs: '  --verbose  '
    })
  })

  it('drops unsafe option keys without mutating object prototypes', () => {
    const value = JSON.parse(
      '{"model":"sonnet","optionValues":{"__proto__":"polluted","constructor":"bad","prototype":true,"effort":"high"}}'
    )
    expect(normalizeAgentLaunchOverrides(value)).toEqual({
      model: 'sonnet',
      optionValues: { effort: 'high' }
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('reports whether any valid persisted value remains', () => {
    expect(isEmptyAgentLaunchOverrides(null)).toBe(true)
    expect(isEmptyAgentLaunchOverrides({})).toBe(true)
    expect(isEmptyAgentLaunchOverrides({ model: 'sonnet' })).toBe(false)
    expect(isEmptyAgentLaunchOverrides({ optionValues: { fastMode: true } })).toBe(false)
    expect(isEmptyAgentLaunchOverrides({ agentArgs: '--verbose' })).toBe(false)
  })
})
