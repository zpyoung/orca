// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import { defaultWatcherOwnerDraft, type WatcherOwnerDraft } from './watcher-owner-draft'
import { WatcherOwnerPicker } from './WatcherOwnerPicker'

// Radix Select mounts its content in a portal only once opened; the native swap keeps every
// option in the document so these assertions read real DOM text without simulating a pointer.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children
  }: {
    value: string
    disabled?: boolean
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    disabled,
    children
  }: {
    value: string
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  )
}))

afterEach(cleanup)

function EditableOwnerPicker(): React.JSX.Element {
  const [draft, setDraft] = useState<WatcherOwnerDraft>(defaultWatcherOwnerDraft())
  return <WatcherOwnerPicker draft={draft} disabled={false} onChange={setDraft} />
}

describe('WatcherOwnerPicker', () => {
  it('starts with the owner switch off and no harness or model controls', () => {
    render(<EditableOwnerPicker />)

    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('offers only claude, lists other harnesses disabled with a stated reason, and populates models from the catalog', () => {
    render(<EditableOwnerPicker />)
    fireEvent.click(screen.getByRole('switch'))

    const [harnessSelect, modelSelect] = screen.getAllByRole('combobox')
    const claudeOption = within(harnessSelect).getByRole('option', { name: 'Claude' })
    expect(claudeOption).not.toBeDisabled()
    for (const label of ['Codex', 'Grok']) {
      expect(within(harnessSelect).getByRole('option', { name: label })).toBeDisabled()
    }
    expect(screen.getByText(/other harnesses cannot own a watcher yet/iu)).toBeInTheDocument()

    const catalog = getAgentSessionOptionCatalog('claude')
    for (const model of catalog?.models ?? []) {
      expect(within(modelSelect).getByRole('option', { name: model.label })).toBeInTheDocument()
    }
  })

  it('reveals the effort select once a model with effort choices is selected', () => {
    render(<EditableOwnerPicker />)
    fireEvent.click(screen.getByRole('switch'))
    const [, modelSelect] = screen.getAllByRole('combobox')

    expect(screen.getAllByRole('combobox')).toHaveLength(2)
    fireEvent.change(modelSelect, { target: { value: 'opus' } })
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
    const [, , effortSelect] = screen.getAllByRole('combobox')
    expect(within(effortSelect).getByRole('option', { name: 'High' })).toBeInTheDocument()
  })
})
