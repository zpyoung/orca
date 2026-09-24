import { describe, expect, it, vi } from 'vitest'

import type { AgentType } from '../../../../../shared/agent-status-types'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG,
  createClaudeCatalogOptions
} from '../../../../../shared/agent-session-option-catalog-claude-codex'
import type {
  CatalogModel,
  CatalogOption
} from '../../../../../shared/agent-session-option-catalog-types'
import type { NativeChatSessionOptionRecord } from '../../../../../shared/native-chat-session-option-state'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  CLAUDE_ULTRACODE_EFFORT,
  isSessionOnly,
  reconciled,
  withChoice
} from './claude-ultracode-effort'

function cloneOption(option: CatalogOption): CatalogOption {
  return {
    ...option,
    kind:
      option.kind.type === 'select'
        ? { ...option.kind, choices: option.kind.choices.map((choice) => ({ ...choice })) }
        : { ...option.kind },
    apply: { ...option.apply }
  }
}

function cloneModels(models: readonly CatalogModel[]): CatalogModel[] {
  return models.map((model) => ({
    ...model,
    options: model.options.map(cloneOption)
  }))
}

function modelById(models: readonly CatalogModel[], id: string): CatalogModel {
  const model = models.find((candidate) => candidate.id === id)
  if (!model) {
    throw new Error(`missing model ${id}`)
  }
  return model
}

function onlyModel(models: readonly CatalogModel[]): CatalogModel {
  const model = models[0]
  if (!model) {
    throw new Error('missing only model')
  }
  return model
}

function effortChoiceValues(model: CatalogModel): string[] {
  const effort = model.options.find((option) => option.id === 'effort')
  if (!effort || effort.kind.type !== 'select') {
    return []
  }
  return effort.kind.choices.map((choice) => choice.value)
}

function ultracodeChoice(model: CatalogModel): { label: string; description?: string } {
  const effort = model.options.find((option) => option.id === 'effort')
  if (!effort || effort.kind.type !== 'select') {
    throw new Error('missing effort select')
  }
  const choice = effort.kind.choices.find(
    (candidate) => candidate.value === CLAUDE_ULTRACODE_EFFORT
  )
  if (!choice) {
    throw new Error('missing ultracode choice')
  }
  return { label: choice.label, description: choice.description }
}

function discoveredModel(effortLevelIds: readonly string[]): CatalogModel {
  return {
    id: 'discovered',
    label: 'Discovered',
    options: createClaudeCatalogOptions({ effortLevelIds })
  }
}

function optionRecord(
  agent: AgentType,
  valuesByModel: NativeChatSessionOptionRecord['valuesByModel']
): NativeChatSessionOptionRecord {
  return { agent, valuesByModel }
}

describe('withChoice', () => {
  it('adds Ultracode to seeded xhigh Claude models only', () => {
    const seedBefore = cloneModels(CLAUDE_SESSION_OPTION_CATALOG.models)

    const models = withChoice('claude', CLAUDE_SESSION_OPTION_CATALOG.models)

    for (const id of ['fable', 'opus', 'sonnet']) {
      const values = effortChoiceValues(modelById(models, id))
      expect(values.at(-1)).toBe(CLAUDE_ULTRACODE_EFFORT)
      expect(values).toContain('xhigh')
    }
    expect(ultracodeChoice(modelById(models, 'sonnet'))).toEqual({
      label: 'Ultracode',
      description: 'Extra high effort with multi-agent workflows · this session only'
    })
    expect(effortChoiceValues(modelById(models, 'haiku'))).toEqual([])
    expect(CLAUDE_SESSION_OPTION_CATALOG.models).toEqual(seedBefore)
  })

  it('derives the choice only for discovered Claude models that advertise xhigh', () => {
    const withoutXhigh = onlyModel(
      withChoice('claude', [discoveredModel(['low', 'medium', 'high'])])
    )
    const withXhigh = onlyModel(
      withChoice('claude', [discoveredModel(['low', 'medium', 'high', 'xhigh'])])
    )

    expect(effortChoiceValues(withoutXhigh)).not.toContain(CLAUDE_ULTRACODE_EFFORT)
    expect(effortChoiceValues(withXhigh).at(-1)).toBe(CLAUDE_ULTRACODE_EFFORT)
  })

  it('is idempotent and leaves inputs unchanged', () => {
    const input = [discoveredModel(['low', 'medium', 'high', 'xhigh'])]
    const inputBefore = cloneModels(input)
    const seedBefore = cloneModels(CLAUDE_SESSION_OPTION_CATALOG.models)

    const once = withChoice('claude', input)
    const twice = withChoice('claude', once)

    expect(
      effortChoiceValues(onlyModel(twice)).filter((value) => value === CLAUDE_ULTRACODE_EFFORT)
    ).toHaveLength(1)
    expect(input).toEqual(inputBefore)
    expect(CLAUDE_SESSION_OPTION_CATALOG.models).toEqual(seedBefore)
  })

  it('does not alter Codex models', () => {
    const codexBefore = cloneModels(CODEX_SESSION_OPTION_CATALOG.models)

    const models = withChoice('codex', CODEX_SESSION_OPTION_CATALOG.models)

    expect(models).not.toBe(CODEX_SESSION_OPTION_CATALOG.models)
    expect(models).toEqual(codexBefore)
    for (const model of models) {
      expect(effortChoiceValues(model)).not.toContain(CLAUDE_ULTRACODE_EFFORT)
    }
    expect(CODEX_SESSION_OPTION_CATALOG.models).toEqual(codexBefore)
  })
})

describe('isSessionOnly', () => {
  it('is true only for Claude Ultracode effort picks', () => {
    expect(isSessionOnly('claude', 'effort', CLAUDE_ULTRACODE_EFFORT)).toBe(true)
    expect(isSessionOnly('codex', 'effort', CLAUDE_ULTRACODE_EFFORT)).toBe(false)
    expect(isSessionOnly('claude', 'model', CLAUDE_ULTRACODE_EFFORT)).toBe(false)
    expect(isSessionOnly('claude', 'effort', 'xhigh')).toBe(false)
    expect(isSessionOnly('claude', 'effort', true)).toBe(false)
  })
})

describe('reconciled', () => {
  it('drops xhigh reports under a tracked Ultracode effort', () => {
    const values = { model: 'sonnet', effort: 'xhigh', fastMode: true }

    expect(
      reconciled(
        optionRecord('claude', {
          sonnet: { effort: { value: CLAUDE_ULTRACODE_EFFORT, source: 'dispatched' } }
        }),
        values
      )
    ).toEqual({ model: 'sonnet', fastMode: true })
  })

  it('keeps other reports and records unchanged', () => {
    const trackedUltracode = optionRecord('claude', {
      sonnet: { effort: { value: CLAUDE_ULTRACODE_EFFORT, source: 'dispatched' } }
    })
    const highReport = { model: 'sonnet', effort: 'high' }
    const trackedMax = optionRecord('claude', {
      sonnet: { effort: { value: 'max', source: 'dispatched' } }
    })
    const xhighReport = { model: 'sonnet', effort: 'xhigh' }
    const absentTracked = optionRecord('claude', {})
    const otherModelReport = { model: 'opus', effort: 'xhigh' }
    const nonClaudeRecord = optionRecord('codex', {
      sonnet: { effort: { value: CLAUDE_ULTRACODE_EFFORT, source: 'dispatched' } }
    })

    expect(reconciled(trackedUltracode, highReport)).toBe(highReport)
    expect(reconciled(trackedMax, xhighReport)).toBe(xhighReport)
    expect(reconciled(absentTracked, xhighReport)).toBe(xhighReport)
    expect(reconciled(trackedUltracode, otherModelReport)).toBe(otherModelReport)
    expect(reconciled(nonClaudeRecord, xhighReport)).toBe(xhighReport)
  })
})
