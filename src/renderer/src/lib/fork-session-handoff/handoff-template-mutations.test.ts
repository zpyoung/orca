import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_TEMPLATE_BODY_MAX } from '../../../../shared/fork-session-handoff/handoff-template-normalization'
import type { ForkSessionHandoffTemplate } from '../../../../shared/fork-session-handoff/handoff-settings-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  createTemplateDraft,
  persistHandoffTemplateMutation,
  saveHandoffTemplate
} from './handoff-template-mutations'

const custom: ForkSessionHandoffTemplate = { id: 'custom', name: 'Custom', body: 'Body' }

describe('handoff template mutations', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('creates a normalized id-backed template draft', () => {
    const draft = createTemplateDraft('  Custom  ', '  Body  ')

    expect(draft).toMatchObject({ name: 'Custom', body: 'Body' })
    expect(draft.id).toMatch(/^handoff-template-/)
  })

  it('sends an operation for atomic application by the settings owner', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const mutation = { type: 'add' as const, template: custom, seedTemplates: [custom] }
    await persistHandoffTemplateMutation({ update, mutation })

    expect(update).toHaveBeenCalledWith({
      forkSessionHandoff: { templateMutation: mutation }
    })
  })

  it('sends reset as an operation instead of a catalog snapshot', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    await persistHandoffTemplateMutation({ update, mutation: { type: 'reset' } })

    expect(update).toHaveBeenCalledWith({
      forkSessionHandoff: { templateMutation: { type: 'reset' } }
    })
  })

  it('rejects an over-limit note without truncating and saving it', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const result = await saveHandoffTemplate({
      name: 'Long',
      body: 'x'.repeat(HANDOFF_TEMPLATE_BODY_MAX + 1),
      update,
      readTemplates: () => undefined
    })

    expect(result).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
})
