import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
  type ForkSessionHandoffSettings
} from './handoff-settings-types'

describe('session handoff settings', () => {
  it('defaults to rich repo context without diff bodies', () => {
    expect(DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES).toEqual({
      repoState: true,
      diffBodies: false,
      openEditorTabs: true
    })
  })

  it('keeps context mode out of global preferences', () => {
    const settings: ForkSessionHandoffSettings = {
      lastAgent: 'codex',
      includeToggles: DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
      lastTemplateId: null,
      templates: [{ id: 'review', name: 'Review', body: 'Review the changes.' }]
    }

    expect(settings).not.toHaveProperty('contextMode')
  })
})
