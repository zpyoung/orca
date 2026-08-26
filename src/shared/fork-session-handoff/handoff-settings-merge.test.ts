import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../global-settings-types'
import { mergeForkSessionHandoffSettings } from './handoff-settings-merge'

function applyPatch(current: GlobalSettings, updates: Partial<GlobalSettings>): GlobalSettings {
  return {
    ...current,
    ...updates,
    ...mergeForkSessionHandoffSettings(current, updates)
  }
}

const originalTemplate = { id: 'original', name: 'Original', body: 'Body' }
const addedTemplate = { id: 'added', name: 'Added', body: 'Body' }

describe('mergeForkSessionHandoffSettings', () => {
  it('preserves templates when a preference-only patch arrives', () => {
    const current = {
      forkSessionHandoff: { templates: [originalTemplate], lastAgent: 'claude' }
    } as GlobalSettings

    expect(
      applyPatch(current, { forkSessionHandoff: { lastAgent: 'codex' } }).forkSessionHandoff
    ).toEqual({ templates: [originalTemplate], lastAgent: 'codex' })
  })

  it('preserves preferences and reconciles selection when templates change', () => {
    const current = {
      forkSessionHandoff: {
        templates: [originalTemplate],
        lastAgent: 'codex',
        includeToggles: { repoState: true, diffBodies: false, openEditorTabs: true },
        lastTemplateId: 'original'
      }
    } as GlobalSettings

    expect(
      applyPatch(current, { forkSessionHandoff: { templates: [addedTemplate] } }).forkSessionHandoff
    ).toEqual({
      templates: [addedTemplate],
      lastAgent: 'codex',
      includeToggles: { repoState: true, diffBodies: false, openEditorTabs: true },
      lastTemplateId: null
    })
  })

  it('resets to live defaults without freezing a catalog', () => {
    const current = {
      forkSessionHandoff: {
        templates: [originalTemplate],
        lastAgent: 'claude',
        lastTemplateId: 'original'
      }
    } as GlobalSettings
    const reset = applyPatch(current, {
      forkSessionHandoff: { templateMutation: { type: 'reset' } }
    })

    expect(reset.forkSessionHandoff).toEqual({
      templates: undefined,
      lastAgent: 'claude',
      lastTemplateId: null
    })
    expect(reset.forkSessionHandoff).toHaveProperty('templates', undefined)
  })

  it('keeps a built-in selection across reset', () => {
    const current = {
      forkSessionHandoff: {
        templates: [originalTemplate],
        lastTemplateId: 'debug-failure'
      }
    } as GlobalSettings

    expect(
      applyPatch(current, {
        forkSessionHandoff: { templateMutation: { type: 'reset' } }
      }).forkSessionHandoff?.lastTemplateId
    ).toBe('debug-failure')
  })

  it('preserves preferences around an atomic template operation in either order', () => {
    const current = {
      forkSessionHandoff: {
        templates: [originalTemplate],
        lastAgent: 'claude',
        lastTemplateId: 'original'
      }
    } as GlobalSettings
    const templatePatch = {
      forkSessionHandoff: {
        templateMutation: {
          type: 'add' as const,
          template: addedTemplate,
          seedTemplates: [originalTemplate]
        }
      }
    }
    const preferencePatch = {
      forkSessionHandoff: { lastAgent: 'codex' as const, lastTemplateId: 'original' }
    }

    const templatesThenPreferences = applyPatch(applyPatch(current, templatePatch), preferencePatch)
    const preferencesThenTemplates = applyPatch(applyPatch(current, preferencePatch), templatePatch)

    for (const result of [templatesThenPreferences, preferencesThenTemplates]) {
      expect(result.forkSessionHandoff).toEqual({
        lastAgent: 'codex',
        lastTemplateId: 'original',
        templates: [originalTemplate, addedTemplate]
      })
    }
  })

  it('does not lose or resurrect rows when add and remove interleave', () => {
    const current = {
      forkSessionHandoff: { templates: [originalTemplate], lastTemplateId: 'original' }
    } as GlobalSettings
    const addPatch = {
      forkSessionHandoff: {
        templateMutation: {
          type: 'add' as const,
          template: addedTemplate,
          seedTemplates: [originalTemplate]
        }
      }
    }
    const removePatch = {
      forkSessionHandoff: {
        templateMutation: {
          type: 'remove' as const,
          id: 'original',
          seedTemplates: [originalTemplate]
        }
      }
    }

    const addThenRemove = applyPatch(applyPatch(current, addPatch), removePatch)
    const removeThenAdd = applyPatch(applyPatch(current, removePatch), addPatch)

    for (const result of [addThenRemove, removeThenAdd]) {
      expect(result.forkSessionHandoff).toEqual({
        templates: [addedTemplate],
        lastTemplateId: null
      })
      expect(result.forkSessionHandoff).not.toHaveProperty('templateMutation')
    }
  })

  it('rejects a stale selection whether deletion or preference persistence lands first', () => {
    const current = {
      forkSessionHandoff: { templates: [originalTemplate], lastTemplateId: 'original' }
    } as GlobalSettings
    const removePatch = {
      forkSessionHandoff: {
        templateMutation: {
          type: 'remove' as const,
          id: 'original',
          seedTemplates: [originalTemplate]
        }
      }
    }
    const preferencePatch = {
      forkSessionHandoff: { lastAgent: 'codex' as const, lastTemplateId: 'original' }
    }

    const deleteThenPreference = applyPatch(applyPatch(current, removePatch), preferencePatch)
    const preferenceThenDelete = applyPatch(applyPatch(current, preferencePatch), removePatch)

    for (const result of [deleteThenPreference, preferenceThenDelete]) {
      expect(result.forkSessionHandoff).toEqual({
        templates: [],
        lastTemplateId: null,
        lastAgent: 'codex'
      })
    }
  })

  it('composes a mutation onto an explicit templates write in the same patch', () => {
    const current = {
      forkSessionHandoff: { templates: [originalTemplate] }
    } as GlobalSettings

    expect(
      applyPatch(current, {
        forkSessionHandoff: {
          templates: [addedTemplate],
          templateMutation: { type: 'add', template: originalTemplate, seedTemplates: [] }
        }
      }).forkSessionHandoff
    ).toEqual({ templates: [addedTemplate, originalTemplate] })
  })
})
