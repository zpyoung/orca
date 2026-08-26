import { describe, expect, it } from 'vitest'
import {
  materializeSourceControlTextGenerationParams,
  resolveSourceControlTextLaunchAgentArgs
} from './source-control-text-launch-args'

describe('resolveSourceControlTextLaunchAgentArgs', () => {
  it('places structured flags before raw arguments', () => {
    expect(
      resolveSourceControlTextLaunchAgentArgs({
        agentId: 'claude',
        launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } },
        agentArgs: '--model opus'
      })
    ).toBe("'--model' 'sonnet' '--effort' 'high' '--model' 'opus'")
  })

  it('preserves malformed raw input so the one-shot planner rejects it', () => {
    expect(
      resolveSourceControlTextLaunchAgentArgs({
        agentId: 'claude',
        launchOptions: { model: 'sonnet' },
        agentArgs: '--flag "unterminated'
      })
    ).toBe('--flag "unterminated')
  })

  it('leaves custom command arguments untouched', () => {
    expect(
      resolveSourceControlTextLaunchAgentArgs({
        agentId: 'custom',
        launchOptions: { model: 'sonnet' },
        agentArgs: '--temperature 0.2'
      })
    ).toBe('--temperature 0.2')
  })
})

describe('materializeSourceControlTextGenerationParams', () => {
  it('applies saved structured options to unattended text generation', () => {
    expect(
      materializeSourceControlTextGenerationParams({
        agentId: 'codex',
        model: 'global-model',
        thinkingLevel: 'medium',
        agentArgs: '--model raw-model',
        launchOptions: { model: 'recipe-model', optionValues: { effort: 'high' } }
      })
    ).toEqual({
      agentId: 'codex',
      model: 'recipe-model',
      thinkingLevel: 'high',
      agentArgs: "'-m' 'recipe-model' '-c' 'model_reasoning_effort=high' '--model' 'raw-model'",
      recipeAgentArgs: '--model raw-model',
      launchOptions: { model: 'recipe-model', optionValues: { effort: 'high' } }
    })
  })

  it('retains option values without applying them until a model is selected', () => {
    expect(
      materializeSourceControlTextGenerationParams({
        agentId: 'codex',
        model: 'global-model',
        thinkingLevel: 'medium',
        launchOptions: { optionValues: { effort: 'high' } }
      })
    ).toEqual({
      agentId: 'codex',
      model: 'global-model',
      thinkingLevel: 'medium',
      launchOptions: { optionValues: { effort: 'high' } },
      recipeAgentArgs: ''
    })
  })
})
