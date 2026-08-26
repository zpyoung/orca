// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchOverrides } from '../../../../shared/agent-launch-overrides'
import type { TuiAgent } from '../../../../shared/types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
}))

vi.mock('@/components/ui/select', () => {
  const React = require('react') as typeof ReactModule
  const Context = React.createContext<{
    disabled: boolean
    onValueChange?: (value: string) => void
  }>({ disabled: false })
  function SelectMock({
    children,
    disabled = false,
    onValueChange,
    value
  }: {
    children: React.ReactNode
    disabled?: boolean
    onValueChange?: (value: string) => void
    value?: string
  }): React.JSX.Element {
    const contextValue = React.useMemo(
      () => ({ disabled, onValueChange }),
      [disabled, onValueChange]
    )
    return (
      <Context.Provider value={contextValue}>
        <div data-select-root data-value={value}>
          {children}
        </div>
      </Context.Provider>
    )
  }
  return {
    Select: SelectMock,
    SelectTrigger: ({
      children,
      id,
      className
    }: {
      children: React.ReactNode
      id?: string
      className?: string
    }) => {
      const context = React.useContext(Context)
      return (
        <button id={id} className={className} disabled={context.disabled} role="combobox">
          {children}
        </button>
      )
    },
    SelectValue: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({
      children,
      value
    }: {
      children: React.ReactNode
      value: string
      textValue?: string
    }) => {
      const context = React.useContext(Context)
      return (
        <button
          type="button"
          role="option"
          disabled={context.disabled}
          data-select-item={value}
          onClick={() => context.onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

vi.mock('@/components/ui/collapsible', () => {
  const React = require('react') as typeof ReactModule
  const Context = React.createContext<{ open: boolean; toggle: () => void }>({
    open: false,
    toggle: () => undefined
  })
  function CollapsibleMock({
    children,
    open = false,
    onOpenChange
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }): React.JSX.Element {
    const contextValue = React.useMemo(
      () => ({ open, toggle: () => onOpenChange?.(!open) }),
      [onOpenChange, open]
    )
    return (
      <Context.Provider value={contextValue}>
        <div>{children}</div>
      </Context.Provider>
    )
  }
  return {
    Collapsible: CollapsibleMock,
    CollapsibleTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => {
      const context = React.useContext(Context)
      return <div onClick={context.toggle}>{children}</div>
    },
    CollapsibleContent: ({
      children,
      className
    }: {
      children: React.ReactNode
      className?: string
    }) => {
      const context = React.useContext(Context)
      return context.open ? <div className={className}>{children}</div> : null
    }
  }
})

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    id,
    onCheckedChange
  }: {
    checked?: boolean
    disabled?: boolean
    id?: string
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <button
      type="button"
      role="switch"
      id={id}
      disabled={disabled}
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
    />
  )
}))

import { AgentLaunchOverridesFields } from './AgentLaunchOverridesFields'

afterEach(() => cleanup())

function Harness(props: {
  agent: TuiAgent | null
  initial: AgentLaunchOverrides
  idPrefix?: string
}): React.JSX.Element {
  const [value, setValue] = useState(props.initial)
  return (
    <>
      <AgentLaunchOverridesFields
        agent={props.agent}
        value={value}
        onChange={(updater) => setValue((current) => updater(current))}
        idPrefix={props.idPrefix ?? 'launch'}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  )
}

describe('AgentLaunchOverridesFields', () => {
  it('disables a picker shadowed by raw arguments and explains why', () => {
    render(
      <AgentLaunchOverridesFields
        agent="claude"
        value={{
          model: 'sonnet',
          optionValues: { effort: 'high' },
          agentArgs: '--effort low'
        }}
        onChange={vi.fn()}
        idPrefix="shadowed"
      />
    )

    expect((document.getElementById('shadowed-option-effort') as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(screen.getByText('Set by CLI arguments')).not.toBeNull()
  })

  it('renders only the inline raw-arguments field for an uncataloged agent', () => {
    render(<Harness agent="aider" initial={{}} />)

    expect(screen.getByLabelText('CLI arguments')).not.toBeNull()
    expect(screen.queryByText('Model')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull()
  })

  it('disables the advanced disclosure with the other launch fields', () => {
    render(
      <AgentLaunchOverridesFields
        agent="claude"
        value={{}}
        onChange={vi.fn()}
        idPrefix="disabled"
        disabled
      />
    )

    expect((screen.getByRole('button', { name: 'Advanced' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('opens the advanced disclosure when persisted raw arguments are non-empty', () => {
    const { rerender } = render(
      <AgentLaunchOverridesFields
        agent="claude"
        value={{}}
        onChange={vi.fn()}
        idPrefix="advanced"
      />
    )
    expect(screen.queryByLabelText('CLI arguments')).toBeNull()

    rerender(
      <AgentLaunchOverridesFields
        agent="claude"
        value={{ agentArgs: '--verbose' }}
        onChange={vi.fn()}
        idPrefix="advanced"
      />
    )
    expect(screen.getByLabelText('CLI arguments')).not.toBeNull()
  })

  it('clears an explicit boolean option back to inherited', () => {
    render(
      <Harness
        agent="cursor"
        initial={{ model: 'gpt-5.3-codex', optionValues: { fastMode: true } }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    const inheritOptions = screen.getAllByRole('option', { name: 'Default' })
    fireEvent.click(inheritOptions.at(-1)!)

    expect(screen.getByTestId('value').textContent).toBe(JSON.stringify({ model: 'gpt-5.3-codex' }))
  })

  it('merges structured changes and removes an empty raw-arguments key', () => {
    render(<Harness agent="claude" initial={{ agentArgs: '--verbose' }} idPrefix="merge" />)

    fireEvent.click(screen.getByRole('option', { name: /Sonnet/ }))
    fireEvent.click(screen.getByRole('option', { name: 'High' }))
    fireEvent.change(screen.getByLabelText('CLI arguments'), { target: { value: '' } })

    expect(screen.getByTestId('value').textContent).toBe(
      JSON.stringify({ model: 'sonnet', optionValues: { effort: 'high' } })
    )
  })
})
