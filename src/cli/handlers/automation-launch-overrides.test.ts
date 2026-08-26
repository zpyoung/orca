import { describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  assertAutomationLaunchOverridesRuntimeSupported,
  getAutomationLaunchOverridesForCreate,
  getAutomationLaunchOverridesForEdit,
  resetAutomationLaunchOverridesForAgentChange
} from './automation-launch-overrides'

const flags = (values: Record<string, string>): Map<string, string | boolean> =>
  new Map(Object.entries(values))

describe('automation CLI launch overrides', () => {
  it('parses and validates create fields', () => {
    expect(
      getAutomationLaunchOverridesForCreate(
        flags({ model: 'sonnet', effort: 'high', 'agent-args': '--verbose' }),
        'claude'
      )
    ).toEqual({
      model: 'sonnet',
      optionValues: { effort: 'high' },
      agentArgs: '--verbose'
    })
  })

  it('rejects unsupported models and effort without a model', () => {
    expect(() =>
      getAutomationLaunchOverridesForCreate(flags({ model: 'custom' }), 'gemini')
    ).toThrow('does not support model custom')
    expect(() =>
      getAutomationLaunchOverridesForCreate(flags({ effort: 'high' }), 'claude')
    ).toThrow('--effort requires --model')
    expect(() =>
      getAutomationLaunchOverridesForCreate(flags({ model: 'sonnet' }), 'hermes')
    ).toThrow('does not support launch-time model selection')
    expect(() =>
      getAutomationLaunchOverridesForCreate(flags({ model: 'inherit' }), 'claude')
    ).toThrow('only supported by automations edit')
  })

  it('allows opaque models only for catalogs with unknown-model options', () => {
    expect(
      getAutomationLaunchOverridesForCreate(
        flags({ model: 'future-claude', effort: 'max' }),
        'claude'
      )
    ).toEqual({ model: 'future-claude', optionValues: { effort: 'max' } })
  })

  it('clears structured values and preserves raw arguments after an agent change', () => {
    expect(
      resetAutomationLaunchOverridesForAgentChange({
        model: 'sonnet',
        optionValues: { effort: 'high' },
        agentArgs: '--verbose'
      })
    ).toEqual({ agentArgs: '--verbose' })
    expect(resetAutomationLaunchOverridesForAgentChange({ agentArgs: '--verbose' })).toBeUndefined()
  })

  it('merges sparse edit fields without erasing unmentioned values', () => {
    expect(
      getAutomationLaunchOverridesForEdit({
        flags: flags({ 'agent-args': '--verbose' }),
        agent: 'claude',
        current: { model: 'sonnet', optionValues: { effort: 'high' } }
      })
    ).toEqual({
      model: 'sonnet',
      optionValues: { effort: 'high' },
      agentArgs: '--verbose'
    })
  })

  it('uses inherit to clear edit fields and collapses an empty override to null', () => {
    expect(
      getAutomationLaunchOverridesForEdit({
        flags: flags({ model: 'inherit' }),
        agent: 'claude',
        current: { model: 'sonnet', optionValues: { effort: 'high' }, agentArgs: '--verbose' }
      })
    ).toEqual({ optionValues: { effort: 'high' }, agentArgs: '--verbose' })
    expect(
      getAutomationLaunchOverridesForEdit({
        flags: flags({ model: 'inherit', effort: 'inherit' }),
        agent: 'claude',
        current: { model: 'sonnet', optionValues: { effort: 'high' } }
      })
    ).toBeNull()
    expect(
      getAutomationLaunchOverridesForEdit({
        flags: flags({ 'agent-args': 'inherit' }),
        agent: 'claude',
        current: { agentArgs: '--verbose' }
      })
    ).toBeNull()
  })

  it('preflights runtime capability only for launch-setting mutations', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { capabilities: [AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY] }
    })
    await assertAutomationLaunchOverridesRuntimeSupported(
      { call } as never,
      flags({ model: 'opus' })
    )
    expect(call).toHaveBeenCalledWith('status.get')

    call.mockClear()
    await assertAutomationLaunchOverridesRuntimeSupported({ call } as never, new Map())
    expect(call).not.toHaveBeenCalled()
  })

  it('blocks a mixed-version runtime before mutation', async () => {
    const call = vi.fn().mockResolvedValue({ result: { capabilities: [] } })
    await expect(
      assertAutomationLaunchOverridesRuntimeSupported({ call } as never, flags({ model: 'opus' }))
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
  })
})
