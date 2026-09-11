// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    settings: { forkSessionHandoff: {} } as {
      forkSessionHandoff?: {
        lastAgent?: 'claude' | 'codex'
        lastTemplateId?: string | null
        templates?: { id: string; name: string; body: string }[]
      }
    },
    updateSettingsOrThrow: vi.fn()
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

vi.mock('./HandoffTemplateEditorDialog', () => ({
  HandoffTemplateEditorDialog: ({ mode }: { mode: 'add' | 'edit' }) => (
    <div data-testid="template-editor">{mode}</div>
  )
}))

import { HandoffTemplatesPane } from './HandoffTemplatesPane'

beforeEach(() => {
  mocks.state.settings = { forkSessionHandoff: {} }
  mocks.state.updateSettingsOrThrow.mockReset().mockResolvedValue(undefined)
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
    await user.click(screen.getByRole('button', { name: 'Add template' }))
    expect(screen.getByTestId('template-editor')).toHaveTextContent('add')
  })

  it('confirms deletion and sends an atomic remove operation', async () => {
    const user = userEvent.setup()
    mocks.state.settings = {
      forkSessionHandoff: {
        lastAgent: 'codex',
        lastTemplateId: 'continue-implementation'
      }
    }
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Remove Continue implementation' }))

    expect(mocks.confirm).toHaveBeenCalledOnce()
    await waitFor(() => expect(mocks.state.updateSettingsOrThrow).toHaveBeenCalledOnce())
    const payload = mocks.state.updateSettingsOrThrow.mock.calls[0]?.[0].forkSessionHandoff
    expect(payload.templateMutation.type).toBe('remove')
    expect(payload.templateMutation.id).toBe('continue-implementation')
    expect(
      payload.templateMutation.seedTemplates.map((template: { id: string }) => template.id)
    ).toEqual(['continue-implementation', 'review-completed-work', 'debug-failure'])
  })

  it('resets a configured catalog with an atomic reset operation', async () => {
    const user = userEvent.setup()
    mocks.state.settings = {
      forkSessionHandoff: {
        lastAgent: 'claude',
        templates: [{ id: 'custom', name: 'Custom', body: 'Body' }]
      }
    }
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))

    await waitFor(() => expect(mocks.state.updateSettingsOrThrow).toHaveBeenCalledOnce())
    const payload = mocks.state.updateSettingsOrThrow.mock.calls[0]?.[0].forkSessionHandoff
    expect(payload).toEqual({ templateMutation: { type: 'reset' } })
  })

  it('reports persistence failures without hiding them', async () => {
    const user = userEvent.setup()
    mocks.state.settings = {
      forkSessionHandoff: {
        templates: [{ id: 'custom', name: 'Custom', body: 'Body' }]
      }
    }
    mocks.state.updateSettingsOrThrow.mockRejectedValue(new Error('disk full'))
    render(<HandoffTemplatesPane />)

    await user.click(screen.getByRole('button', { name: 'Remove Custom' }))

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not save templates', {
        description: 'disk full'
      })
    )
  })
})
