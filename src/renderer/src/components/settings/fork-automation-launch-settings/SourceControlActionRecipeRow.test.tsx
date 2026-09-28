import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceControlActionRecipeRow } from '../SourceControlActionRecipeRow'

describe('SourceControlActionRecipeRow', () => {
  it('renders recipe launch options through the shared launch fields', () => {
    const value = {
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--verbose',
      launchOptions: { model: 'sonnet' }
    }
    const markup = renderToStaticMarkup(
      React.createElement(SourceControlActionRecipeRow, {
        actionId: 'fixChecks',
        selectedAgent: 'claude',
        draftValue: value,
        baseValue: value,
        defaultTuiAgent: 'codex',
        isSavingRecipe: false,
        onAgentChange: () => {},
        onTemplateChange: () => {},
        onAgentArgsChange: () => {},
        onLaunchOptionsChange: () => {},
        onAppendVariable: () => {},
        onDiscard: () => {},
        onSave: () => {}
      })
    )

    expect(markup).toContain('source-control-action-fixChecks-model')
    expect(markup).toContain('Model')
    expect(markup).toContain('Advanced')
    expect(markup).toContain('--verbose')
  })
})
