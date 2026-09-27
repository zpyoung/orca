// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
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

import { HandoffTemplateEditorDialog } from './HandoffTemplateEditorDialog'

afterEach(cleanup)

describe('HandoffTemplateEditorDialog', () => {
  it('requires both a name and instruction body and documents template variables', async () => {
    const user = userEvent.setup()
    render(
      <HandoffTemplateEditorDialog
        open
        mode="add"
        template={{ id: 'draft', name: '', body: '' }}
        templates={[]}
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
      />
    )

    const save = screen.getByRole('button', { name: 'Save template' })
    expect(save).toBeDisabled()
    expect(screen.getByText(/Variables: \{\{gitStatus\}\}/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Name'), 'Template')
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText('Instructions'), 'Do the work')
    expect(save).toBeEnabled()
  })

  it('blocks dismissal controls while persistence is pending', async () => {
    const user = userEvent.setup()
    let resolveSave: ((saved: boolean) => void) | undefined
    const pendingSave = new Promise<boolean>((resolve) => {
      resolveSave = resolve
    })
    render(
      <HandoffTemplateEditorDialog
        open
        mode="add"
        template={{ id: 'draft', name: 'Name', body: 'Body' }}
        templates={[]}
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockReturnValue(pendingSave)}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Save template' }))
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByLabelText('Instructions')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    resolveSave?.(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled())
  })

  it('saves trimmed values and closes after persistence succeeds', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    const onOpenChange = vi.fn()
    render(
      <HandoffTemplateEditorDialog
        open
        mode="edit"
        template={{ id: 'draft', name: ' Old ', body: ' Old body ' }}
        templates={[]}
        onOpenChange={onOpenChange}
        onSave={onSave}
      />
    )

    const name = screen.getByLabelText('Name')
    const body = screen.getByLabelText('Instructions')
    await user.clear(name)
    await user.type(name, '  New name  ')
    await user.clear(body)
    await user.type(body, '  New body  ')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'New name', body: 'New body' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps duplicate names non-blocking', async () => {
    const user = userEvent.setup()
    render(
      <HandoffTemplateEditorDialog
        open
        mode="add"
        template={{ id: 'draft', name: '', body: 'Body' }}
        templates={[{ id: 'existing', name: 'Existing', body: 'Body' }]}
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
      />
    )

    await user.type(screen.getByLabelText('Name'), 'Existing')
    expect(screen.getByRole('status')).toHaveTextContent('Another template uses this name')
    expect(screen.getByRole('button', { name: 'Save template' })).toBeEnabled()
  })
})
