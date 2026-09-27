// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HANDOFF_TEMPLATE_BODY_MAX,
  HANDOFF_TEMPLATES_MAX
} from '../../../../../shared/fork-session-handoff/handoff-template-normalization'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/select', () => {
  let changeValue: ((value: string) => void) | undefined
  return {
    Select: ({
      children,
      onValueChange
    }: {
      children: ReactNode
      onValueChange: (value: string) => void
    }) => {
      changeValue = onValueChange
      return <div>{children}</div>
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({
      children,
      value,
      disabled,
      title
    }: {
      children: ReactNode
      value: string
      disabled?: boolean
      title?: string
    }) => (
      <button
        type="button"
        role="option"
        disabled={disabled}
        title={title}
        onClick={() => changeValue?.(value)}
      >
        {children}
      </button>
    ),
    SelectTrigger: ({ children, ...props }: { children: ReactNode; id?: string }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => <span>No template</span>
  }
})

import { HandoffNotesControls } from './HandoffNotesControls'

const templates = [{ id: 'default', name: 'Default', body: 'Body' }]

function renderControls(
  props: Partial<React.ComponentProps<typeof HandoffNotesControls>> = {}
): ReturnType<typeof render> {
  return render(
    <HandoffNotesControls
      disabled={false}
      templates={templates}
      selectedTemplateId={null}
      steeringNote="Focus on tests"
      onTemplateChange={vi.fn()}
      onSteeringNoteChange={vi.fn()}
      onSaveSteeringNoteAsTemplate={vi.fn().mockResolvedValue(true)}
      {...props}
    />
  )
}

afterEach(cleanup)

describe('HandoffNotesControls template capture', () => {
  it('opens template creation for a blank note while keeping save disabled', async () => {
    const user = userEvent.setup()
    renderControls({ steeringNote: '   ' })

    const newTemplate = screen.getByRole('option', { name: 'New Template' })
    expect(newTemplate).toBeEnabled()
    await user.click(newTemplate)
    await user.type(screen.getByLabelText('Template name'), 'Blank note')

    expect(screen.getByRole('button', { name: 'Save template' })).toBeDisabled()
  })

  it('disables the template selector with the surrounding controls', () => {
    renderControls({ disabled: true })

    expect(screen.getByRole('button', { name: 'Reusable template' })).toBeDisabled()
  })

  it('keeps an over-limit note intact but allows opening template creation', async () => {
    const user = userEvent.setup()
    const note = 'x'.repeat(HANDOFF_TEMPLATE_BODY_MAX + 1)
    renderControls({ steeringNote: note })

    expect(screen.getByRole('alert')).toHaveTextContent('Shorten this note')
    const newTemplate = screen.getByRole('option', { name: 'New Template' })
    expect(newTemplate).toBeEnabled()
    await user.click(newTemplate)
    await user.type(screen.getByLabelText('Template name'), 'Long note')

    expect(screen.getByRole('button', { name: 'Save template' })).toBeDisabled()
    expect(screen.getByLabelText('Steering note')).toHaveValue(note)
  })

  it('opens template creation at the catalog limit while keeping save disabled', async () => {
    const user = userEvent.setup()
    const fullCatalog = Array.from({ length: HANDOFF_TEMPLATES_MAX }, (_, index) => ({
      id: `template-${index}`,
      name: `Template ${index}`,
      body: 'Body'
    }))
    renderControls({ templates: fullCatalog })

    const newTemplate = screen.getByRole('option', { name: 'New Template' })
    expect(newTemplate).toBeEnabled()
    await user.click(newTemplate)
    await user.type(screen.getByLabelText('Template name'), 'At limit')

    expect(screen.getByRole('button', { name: 'Save template' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('The template limit has been reached.')
  })

  it('disables conflicting controls while a save is pending', async () => {
    const user = userEvent.setup()
    let resolveSave: ((saved: boolean) => void) | undefined
    const pendingSave = new Promise<boolean>((resolve) => {
      resolveSave = resolve
    })
    renderControls({ onSaveSteeringNoteAsTemplate: vi.fn().mockReturnValue(pendingSave) })

    await user.click(screen.getByRole('option', { name: 'New Template' }))
    await user.type(screen.getByLabelText('Template name'), 'Pending')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    expect(screen.getByLabelText('Steering note')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    resolveSave?.(true)
    await waitFor(() => expect(screen.queryByLabelText('Template name')).not.toBeInTheDocument())
  })

  it('collects a name inline and saves the steering note as a template', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    renderControls({ onSaveSteeringNoteAsTemplate: onSave })

    await user.click(screen.getByRole('option', { name: 'New Template' }))
    await user.type(screen.getByLabelText('Template name'), ' Review work ')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Review work'))
    expect(screen.queryByRole('button', { name: 'Save as template' })).not.toBeInTheDocument()
  })

  it('cancels the inline name field on Escape without bubbling', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <HandoffNotesControls
          disabled={false}
          templates={templates}
          selectedTemplateId={null}
          steeringNote="Focus on tests"
          onTemplateChange={vi.fn()}
          onSteeringNoteChange={vi.fn()}
          onSaveSteeringNoteAsTemplate={vi.fn().mockResolvedValue(true)}
        />
      </div>
    )

    await user.click(screen.getByRole('option', { name: 'New Template' }))
    await user.keyboard('{Escape}')

    expect(screen.queryByLabelText('Template name')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save as template' })).not.toBeInTheDocument()
    expect(onKeyDown).not.toHaveBeenCalled()
  })
})
