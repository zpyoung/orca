// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { mergeForkSessionHandoffSettings } from '../../../../../shared/fork-session-handoff/handoff-settings-merge'
import type { ForkSessionHandoffTemplate } from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import { HANDOFF_TEMPLATES_MAX } from '../../../../../shared/fork-session-handoff/handoff-template-normalization'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const updateSettingsOrThrow = vi.fn<(updates: Partial<GlobalSettings>) => Promise<void>>()
  const state: {
    settings: GlobalSettings | null
    updateSettingsOrThrow: typeof updateSettingsOrThrow
  } = {
    settings: null,
    updateSettingsOrThrow
  }
  return { state, confirm: vi.fn(), toastError: vi.fn() }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

import { HandoffTemplatesPane } from './HandoffTemplatesPane'

const FULL_CATALOG: ForkSessionHandoffTemplate[] = Array.from(
  { length: HANDOFF_TEMPLATES_MAX },
  (_unused, index) => ({
    id: `existing-${index}`,
    name: `Existing ${index}`,
    body: `Body ${index}`
  })
)

function mergeInto(current: GlobalSettings, updates: Partial<GlobalSettings>): GlobalSettings {
  return {
    ...current,
    ...updates,
    ...mergeForkSessionHandoffSettings(current, updates)
  }
}

function applySettingsUpdate(updates: Partial<GlobalSettings>): void {
  const current = mocks.state.settings
  if (!current) {
    throw new Error('Settings must be initialized before applying an update')
  }
  mocks.state.settings = mergeInto(current, updates)
}

/**
 * Builds an update implementation whose merge runs against `templates` rather than against what
 * the pane last read, so a mutation the owning process rejects reaches the pane the way a
 * concurrent writer's catalog would.
 */
function publishAgainstCatalog(
  templates: ForkSessionHandoffTemplate[] | undefined
): (updates: Partial<GlobalSettings>) => Promise<void> {
  let authoritative: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    forkSessionHandoff: { templates }
  }
  return async (updates) => {
    authoritative = mergeInto(authoritative, updates)
    mocks.state.settings = authoritative
  }
}

beforeEach(() => {
  mocks.state.settings = { ...getDefaultSettings('/tmp'), forkSessionHandoff: {} }
  mocks.state.updateSettingsOrThrow.mockReset().mockImplementation(async (updates) => {
    applySettingsUpdate(updates)
  })
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.toastError.mockReset()
})

afterEach(cleanup)

describe('HandoffTemplatesPane', () => {
  it('lists built-ins before the first edit and opens the add editor', async () => {
    const user = userEvent.setup()
    render(<HandoffTemplatesPane />)

    expect(screen.getByText('Continue implementation')).toBeInTheDocument()
    expect(screen.getByText('Review what was done')).toBeInTheDocument()
    expect(screen.getByText('Debug the failure')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add template' }))
    expect(screen.getByRole('heading', { name: 'Add template' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Instructions')).toHaveValue('')
  })

  it('confirms deletion and sends an atomic remove operation', async () => {
    const user = userEvent.setup()
    mocks.state.settings = {
      ...getDefaultSettings('/tmp'),
      forkSessionHandoff: {
        lastAgent: 'codex',
        lastTemplateId: 'continue-implementation'
      }
    }
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Remove Continue implementation' }))

    expect(mocks.confirm).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.state.updateSettingsOrThrow).toHaveBeenCalledOnce())
    expect(mocks.state.updateSettingsOrThrow).toHaveBeenCalledWith({
      forkSessionHandoff: {
        templateMutation: {
          type: 'remove',
          id: 'continue-implementation',
          seedTemplates: [
            expect.objectContaining({ id: 'continue-implementation' }),
            expect.objectContaining({ id: 'review-completed-work' }),
            expect.objectContaining({ id: 'debug-failure' })
          ]
        }
      }
    })
  })

  it('writes nothing when the delete confirmation is declined', async () => {
    const user = userEvent.setup()
    mocks.confirm.mockResolvedValue(false)
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Remove Continue implementation' }))

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce())
    expect(mocks.state.updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(screen.getByText('Continue implementation')).toBeInTheDocument()
  })

  it('resets a configured catalog with an atomic reset operation', async () => {
    const user = userEvent.setup()
    mocks.state.settings = {
      ...getDefaultSettings('/tmp'),
      forkSessionHandoff: {
        lastAgent: 'claude',
        templates: [{ id: 'custom', name: 'Custom', body: 'Body' }]
      }
    }
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))

    await waitFor(() => expect(mocks.state.updateSettingsOrThrow).toHaveBeenCalledOnce())
    expect(mocks.state.updateSettingsOrThrow).toHaveBeenCalledWith({
      forkSessionHandoff: { templateMutation: { type: 'reset' } }
    })
  })

  it('keeps an add draft open and reports when the authoritative catalog rejects it', async () => {
    const user = userEvent.setup()
    mocks.state.updateSettingsOrThrow.mockImplementation(publishAgainstCatalog(FULL_CATALOG))
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Add template' }))
    await user.type(screen.getByLabelText('Name'), 'Rejected add')
    await user.type(screen.getByLabelText('Instructions'), 'Keep this add draft')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
    expect(mocks.toastError).toHaveBeenCalledWith('Could not save templates')
    expect(screen.getByRole('heading', { name: 'Add template' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Rejected add')
    expect(screen.getByLabelText('Instructions')).toHaveValue('Keep this add draft')
  })

  it('keeps an edit draft open and reports when the authoritative catalog rejects it', async () => {
    const user = userEvent.setup()
    mocks.state.settings = {
      ...getDefaultSettings('/tmp'),
      forkSessionHandoff: {
        templates: [{ id: 'custom', name: 'Original name', body: 'Original body' }]
      }
    }
    mocks.state.updateSettingsOrThrow.mockImplementation(publishAgainstCatalog([]))
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Edit Original name' }))
    const name = screen.getByLabelText('Name')
    const body = screen.getByLabelText('Instructions')
    await user.clear(name)
    await user.type(name, 'Rejected edit')
    await user.clear(body)
    await user.type(body, 'Keep this edit draft')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
    expect(mocks.toastError).toHaveBeenCalledWith('Could not save templates')
    expect(screen.getByRole('heading', { name: 'Edit template' })).toBeInTheDocument()
    expect(name).toHaveValue('Rejected edit')
    expect(body).toHaveValue('Keep this edit draft')
  })

  it('closes an accepted save without reporting an error', async () => {
    const user = userEvent.setup()
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Add template' }))
    await user.type(screen.getByLabelText('Name'), 'Accepted template')
    await user.type(screen.getByLabelText('Instructions'), 'Persist this template')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Add template' })).not.toBeInTheDocument()
    )
    expect(screen.getByText('Accepted template')).toBeInTheDocument()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('reports a thrown save once and keeps the draft open', async () => {
    const user = userEvent.setup()
    mocks.state.updateSettingsOrThrow.mockRejectedValue(new Error('disk full'))
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Add template' }))
    await user.type(screen.getByLabelText('Name'), 'Unsaved template')
    await user.type(screen.getByLabelText('Instructions'), 'Keep this after failure')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
    expect(mocks.toastError).toHaveBeenCalledWith('Could not save templates', {
      description: 'disk full'
    })
    expect(screen.getByRole('heading', { name: 'Add template' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved template')
    expect(screen.getByLabelText('Instructions')).toHaveValue('Keep this after failure')
  })
})
