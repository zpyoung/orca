import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG,
  createClaudeCatalogOptions
} from '../../../../../shared/agent-session-option-catalog-claude-codex'
import type { CatalogModel } from '../../../../../shared/agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../../../../../shared/agent-session-option-launch'
import type { SessionOptionDescriptor } from '../../../../../shared/native-chat-session-options'
import { readClaudeSessionOptionsFromTerminalScreen } from '../claude-terminal-session-options'
import type { NativeChatSessionOptionDispatchCommand } from '../native-chat-session-option-command-dispatch'
import { clearNativeChatSessionOptionCacheForTests } from '../native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from '../native-chat-pty-session-options'
import { withUltracodeRung } from './claude-ultracode-effort-rung'

type SelectDescriptor = SessionOptionDescriptor & {
  kind: Extract<SessionOptionDescriptor['kind'], { type: 'select' }>
}

function isSelectDescriptor(
  descriptor: SessionOptionDescriptor | undefined
): descriptor is SelectDescriptor {
  return descriptor?.kind.type === 'select'
}

function catalogModel(models: readonly CatalogModel[], modelId: string): CatalogModel {
  const model = models.find((candidate) => candidate.id === modelId)
  if (!model) {
    throw new Error(`Missing catalog model: ${modelId}`)
  }
  return model
}

function effortChoiceValues(model: CatalogModel): string[] {
  const effort = model.options.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : []
}

function modelEffortChoiceValues(models: readonly CatalogModel[], modelId: string): string[] {
  return effortChoiceValues(catalogModel(models, modelId))
}

function selectDescriptor(
  snapshot: readonly SessionOptionDescriptor[],
  id: string
): SelectDescriptor {
  const descriptor = snapshot.find((candidate) => candidate.id === id)
  if (!isSelectDescriptor(descriptor)) {
    throw new Error(`Missing select descriptor: ${id}`)
  }
  return descriptor
}

function descriptorChoiceValues(
  snapshot: readonly SessionOptionDescriptor[],
  id: string
): string[] {
  return selectDescriptor(snapshot, id).kind.choices.map((choice) => choice.value)
}

function createClaudeSurface(args: {
  scopeKey: string
  reportedValues?: Record<string, string>
  initialModels?: readonly CatalogModel[]
  dispatchCommand?: NativeChatSessionOptionDispatchCommand
}) {
  const surface = createNativeChatPtySessionOptions({
    agent: 'claude',
    scopeKey: args.scopeKey,
    mode: 'live',
    ...(args.reportedValues ? { reportedValues: args.reportedValues } : {}),
    ...(args.initialModels ? { initialModels: args.initialModels } : {}),
    dispatchCommand: args.dispatchCommand ?? vi.fn<NativeChatSessionOptionDispatchCommand>()
  })
  if (!surface) {
    throw new Error('Claude session options surface should exist')
  }
  return surface
}

function discoveredClaudeModel(modelId = 'sonnet'): CatalogModel {
  return {
    id: modelId,
    label: `Live ${modelId}`,
    options: createClaudeCatalogOptions({
      effortLevelIds: ['low', 'medium', 'high', 'xhigh'],
      supportsFastMode: false
    })
  }
}

describe('withUltracodeRung', () => {
  it('adds Ultracode only to Claude xhigh effort rows without mutating inputs', () => {
    const sonnet: CatalogModel = {
      id: 'sonnet',
      label: 'Sonnet',
      options: createClaudeCatalogOptions({
        effortLevelIds: ['low', 'medium', 'high', 'xhigh', 'max'],
        supportsFastMode: false
      })
    }
    const haiku = catalogModel(CLAUDE_SESSION_OPTION_CATALOG.models, 'haiku')
    const limited: CatalogModel = {
      id: 'limited',
      label: 'Limited',
      options: createClaudeCatalogOptions({
        effortLevelIds: ['low', 'medium', 'high'],
        supportsFastMode: false
      })
    }
    const input = [sonnet, haiku, limited]
    const originalOptions = sonnet.options
    const originalChoices = effortChoiceValues(sonnet)

    const once = withUltracodeRung('claude', input)
    const twice = withUltracodeRung('claude', once)

    expect(modelEffortChoiceValues(once, 'sonnet')).toEqual([...originalChoices, 'ultracode'])
    expect(modelEffortChoiceValues(once, 'haiku')).toEqual([])
    expect(modelEffortChoiceValues(once, 'limited')).toEqual(['low', 'medium', 'high'])
    expect(modelEffortChoiceValues(twice, 'sonnet')).toEqual(
      modelEffortChoiceValues(once, 'sonnet')
    )
    expect(modelEffortChoiceValues(twice, 'sonnet')).toContain('ultracode')
    expect(
      modelEffortChoiceValues(twice, 'sonnet').filter((value) => value === 'ultracode')
    ).toHaveLength(1)
    expect(input).toEqual([sonnet, haiku, limited])
    expect(sonnet.options).toBe(originalOptions)
    expect(effortChoiceValues(sonnet)).toEqual(originalChoices)
  })

  it('does not add Ultracode for non-Claude agents', () => {
    const codex = catalogModel(CODEX_SESSION_OPTION_CATALOG.models, 'gpt-5.5')

    const result = withUltracodeRung('codex', [codex])

    expect(modelEffortChoiceValues(result, 'gpt-5.5')).toEqual(effortChoiceValues(codex))
    expect(modelEffortChoiceValues(result, 'gpt-5.5')).not.toContain('ultracode')
  })
})

describe('Claude Ultracode PTY session options', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('offers Ultracode from seed, discovered, and tracked model sources', () => {
    const surface = createClaudeSurface({
      scopeKey: 'ultracode-model-sources',
      reportedValues: { model: 'sonnet', effort: 'high' }
    })

    expect(descriptorChoiceValues(surface.getSnapshot(), 'effort')).toContain('ultracode')

    surface.replaceModels([discoveredClaudeModel('sonnet')])
    expect(descriptorChoiceValues(surface.getSnapshot(), 'effort')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'ultracode'
    ])

    surface.replaceModels([discoveredClaudeModel('opus[1m]')])
    expect(selectDescriptor(surface.getSnapshot(), 'model').kind.currentValue).toBe('sonnet')
    expect(descriptorChoiceValues(surface.getSnapshot(), 'effort')).toContain('ultracode')
  })

  it('dispatches and launches Ultracode through the existing Claude effort apply mapping', async () => {
    const dispatchCommand = vi
      .fn<NativeChatSessionOptionDispatchCommand>()
      .mockResolvedValue(undefined)
    const surface = createClaudeSurface({
      scopeKey: 'ultracode-apply',
      reportedValues: { model: 'sonnet', effort: 'high' },
      dispatchCommand
    })

    await surface.setOption('effort', 'ultracode')

    expect(dispatchCommand).toHaveBeenCalledWith('/effort ultracode')
    expect(selectDescriptor(surface.getSnapshot(), 'effort').kind.currentValue).toBe('ultracode')
    expect(
      resolveAgentSessionOptionLaunch('claude', { model: 'sonnet', effort: 'ultracode' })
    ).toEqual({
      args: ['--model', 'sonnet', '--effort', 'ultracode'],
      appliedValues: { model: 'sonnet', effort: 'ultracode' }
    })
  })

  it('keeps an Ultracode pick when the committed Claude transcript reports xhigh', async () => {
    const transcript = readFileSync(
      new URL('./__fixtures__/claude-ultracode-startup.txt', import.meta.url),
      'utf8'
    )
    const reportedValues = readClaudeSessionOptionsFromTerminalScreen(transcript)
    const surface = createClaudeSurface({
      scopeKey: 'ultracode-fixture-reconcile',
      reportedValues: { model: 'sonnet', effort: 'high' },
      dispatchCommand: vi.fn<NativeChatSessionOptionDispatchCommand>().mockResolvedValue(undefined)
    })

    await surface.setOption('effort', 'ultracode')
    surface.reportSessionOptions(reportedValues ?? {}, Number.MAX_SAFE_INTEGER)

    expect(reportedValues).toEqual({ model: 'sonnet', effort: 'xhigh' })
    expect(selectDescriptor(surface.getSnapshot(), 'effort').kind.currentValue).toBe('ultracode')
  })
})

describe('Claude Ultracode structured leak guard', () => {
  it('keeps Ultracode out of the shared Claude catalog', () => {
    const catalogEfforts = CLAUDE_SESSION_OPTION_CATALOG.models.flatMap(effortChoiceValues)

    expect(catalogEfforts).not.toContain('ultracode')
  })
})
