import { describe, expect, it } from 'vitest'
import { buildAgentLaunchOverridesFieldState } from './agent-launch-overrides-field-state'

describe('buildAgentLaunchOverridesFieldState', () => {
  it('derives model entries only for cataloged agents', () => {
    const cataloged = buildAgentLaunchOverridesFieldState('claude', {})
    expect(cataloged.catalog).not.toBeNull()
    expect(cataloged.modelEntries[0]).toEqual({ value: undefined })
    expect(cataloged.modelEntries.some((entry) => entry.value === 'sonnet')).toBe(true)
    expect(cataloged.optionDescriptors).toEqual([])

    const uncataloged = buildAgentLaunchOverridesFieldState('aider', {})
    expect(uncataloged).toMatchObject({
      catalog: null,
      modelEntries: [],
      optionDescriptors: [],
      unknownModelId: null
    })
    expect(uncataloged.shadowedIds.size).toBe(0)

    const noAgent = buildAgentLaunchOverridesFieldState(null, {})
    expect(noAgent).toMatchObject({
      catalog: null,
      modelEntries: [],
      optionDescriptors: [],
      unknownModelId: null
    })
  })

  it('retains an opaque persisted model and uses unknown-model options', () => {
    const state = buildAgentLaunchOverridesFieldState('claude', {
      model: 'claude-fable-5',
      optionValues: { effort: 'high' }
    })

    expect(state.unknownModelId).toBe('claude-fable-5')
    expect(state.modelEntries.at(-1)).toEqual({
      value: 'claude-fable-5',
      label: 'claude-fable-5',
      opaque: true
    })
    expect(state.optionDescriptors.map((descriptor) => descriptor.id)).toEqual(['effort'])
    expect(state.optionDescriptors[0]?.value).toBe('high')
  })

  it('exposes raw-argument shadowing as a set', () => {
    const state = buildAgentLaunchOverridesFieldState('claude', {
      model: 'sonnet',
      optionValues: { effort: 'high' },
      agentArgs: '--model haiku --effort low'
    })

    expect([...state.shadowedIds]).toEqual(['model', 'effort'])
  })

  it('builds tri-state boolean entries only for launch-capable options', () => {
    const cursor = buildAgentLaunchOverridesFieldState('cursor', {
      model: 'gpt-5.3-codex'
    })
    const fastMode = cursor.optionDescriptors.find((descriptor) => descriptor.id === 'fastMode')

    expect(fastMode).toMatchObject({ kind: 'boolean', value: undefined })
    expect(fastMode?.entries.map((entry) => entry.value)).toEqual([undefined, true, false])

    const claude = buildAgentLaunchOverridesFieldState('claude', { model: 'opus' })
    expect(claude.optionDescriptors.map((descriptor) => descriptor.id)).toEqual(['effort'])
  })
})
