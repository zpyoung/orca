// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { type ReactNode } from 'react'

import type { CatalogModel } from '../../../../../shared/agent-session-option-catalog-types'
import { createClaudeCatalogOptions } from '../../../../../shared/agent-session-option-catalog-claude-codex'
import type { SessionOptionDescriptor } from '../../../../../shared/native-chat-session-options'
import { NativeChatSessionOptionPickers } from '../NativeChatSessionOptionPickers'
import { clearNativeChatSessionOptionCacheForTests } from '../native-chat-session-option-cache'
import {
  createNativeChatPtySessionOptions,
  type CreateNativeChatPtySessionOptionsArgs,
  type NativeChatPtySessionOptionsSurface
} from '../native-chat-pty-session-options'
import type { NativeChatSessionOptionDispatchCommand } from '../native-chat-session-option-command-dispatch'
import { CLAUDE_ULTRACODE_EFFORT } from './claude-ultracode-effort'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) => {
    if (!values) {
      return fallback
    }
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
  }
}))

vi.mock('@/components/ui/button', () => {
  const React = require('react')
  return {
    Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      React.createElement('button', props, children)
  }
})

vi.mock('@/components/ui/switch', () => {
  const React = require('react')
  return {
    SwitchIndicator: ({ checked }: { checked: boolean }) =>
      React.createElement('span', { 'data-checked': checked })
  }
})

vi.mock('@/components/ui/tooltip', () => {
  const React = require('react')
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children)
  return {
    Tooltip: Passthrough,
    TooltipTrigger: Passthrough,
    TooltipContent: ({ children }: { children?: ReactNode }) =>
      React.createElement('div', null, children)
  }
})

vi.mock('@/components/ui/dropdown-menu', () => {
  const React = require('react')
  type LooseProps = {
    children?: ReactNode
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
    value?: string
    [key: string]: unknown
  }
  const Passthrough = ({ children }: LooseProps) =>
    React.createElement(React.Fragment, null, children)
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: ({ children }: LooseProps) => React.createElement('div', null, children),
    DropdownMenuLabel: ({ children }: LooseProps) => React.createElement('div', null, children),
    DropdownMenuSeparator: () => React.createElement('hr'),
    DropdownMenuItem: ({ children, disabled, onSelect, ...props }: LooseProps) =>
      React.createElement(
        'button',
        {
          ...props,
          disabled,
          onClick: () => onSelect?.({ preventDefault: () => {} })
        },
        children
      ),
    DropdownMenuRadioGroup: ({ children, value, 'aria-label': ariaLabel }: LooseProps) =>
      React.createElement(
        'div',
        { role: 'radiogroup', 'aria-label': ariaLabel, 'data-value': value },
        children
      ),
    DropdownMenuRadioItem: ({ children, disabled, value }: LooseProps) =>
      React.createElement(
        'div',
        { role: 'radio', 'aria-disabled': disabled, 'data-value': value },
        children
      )
  }
})

type SurfaceArgs = Partial<CreateNativeChatPtySessionOptionsArgs> & {
  agent: CreateNativeChatPtySessionOptionsArgs['agent']
}

function createSurface(args: SurfaceArgs): NativeChatPtySessionOptionsSurface {
  const surface = createNativeChatPtySessionOptions({
    scopeKey: `${args.agent}-scope`,
    mode: 'live',
    dispatchCommand: vi.fn(),
    ...args
  })
  if (!surface) {
    throw new Error(`missing surface for ${args.agent}`)
  }
  return surface
}

function descriptor(
  surface: NativeChatPtySessionOptionsSurface,
  id: string
): SessionOptionDescriptor | undefined {
  return surface.getSnapshot().find((candidate) => candidate.id === id)
}

function selectChoiceValues(surface: NativeChatPtySessionOptionsSurface, id: string): string[] {
  const option = descriptor(surface, id)
  if (!option || option.kind.type !== 'select') {
    return []
  }
  return option.kind.choices.map((choice) => choice.value)
}

function selectCurrentValue(
  surface: NativeChatPtySessionOptionsSurface,
  id: string
): string | undefined {
  const option = descriptor(surface, id)
  if (!option || option.kind.type !== 'select') {
    return undefined
  }
  return option.kind.currentValue
}

function discoveredModel(effortLevelIds: readonly string[]): CatalogModel {
  return {
    id: 'claude-custom',
    label: 'Claude Custom',
    options: createClaudeCatalogOptions({ effortLevelIds })
  }
}

describe('Claude Ultracode PTY session options', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())
  afterEach(() => cleanup())

  it('offers Ultracode for tracked xhigh-capable Claude models only', () => {
    const opus = createSurface({ agent: 'claude', reportedValues: { model: 'opus' } })
    expect(selectChoiceValues(opus, 'effort').at(-1)).toBe(CLAUDE_ULTRACODE_EFFORT)

    const haiku = createSurface({
      agent: 'claude',
      scopeKey: 'claude-haiku',
      reportedValues: { model: 'haiku' }
    })
    expect(descriptor(haiku, 'effort')).toBeUndefined()
  })

  it('updates discovered Claude models based on their xhigh support', () => {
    const surface = createSurface({
      agent: 'claude',
      reportedValues: { model: 'claude-custom' },
      initialModels: []
    })

    surface.replaceModels([discoveredModel(['low', 'medium', 'high', 'xhigh'])])
    expect(selectChoiceValues(surface, 'effort')).toContain(CLAUDE_ULTRACODE_EFFORT)

    surface.replaceModels([discoveredModel(['low', 'medium', 'high'])])
    expect(selectChoiceValues(surface, 'effort')).not.toContain(CLAUDE_ULTRACODE_EFFORT)
  })

  it('dispatches Ultracode without persisting it and still persists normal efforts', async () => {
    const dispatchCommand: NativeChatSessionOptionDispatchCommand = vi.fn()
    const persistSelection = vi.fn()
    const surface = createSurface({
      agent: 'claude',
      reportedValues: { model: 'opus' },
      dispatchCommand,
      persistSelection
    })

    await surface.setOption('effort', CLAUDE_ULTRACODE_EFFORT)
    expect(dispatchCommand).toHaveBeenCalledWith('/effort ultracode')
    expect(selectCurrentValue(surface, 'effort')).toBe(CLAUDE_ULTRACODE_EFFORT)
    expect(persistSelection).not.toHaveBeenCalled()

    await surface.setOption('effort', 'high')
    expect(dispatchCommand).toHaveBeenLastCalledWith('/effort high')
    expect(persistSelection).toHaveBeenCalledWith({
      modelId: 'opus',
      optionId: 'effort',
      value: 'high',
      adoptModelAsLaunchDefault: true
    })
  })

  it('tracks a typed Ultracode effort command without persisting it', () => {
    const persistSelection = vi.fn()
    const surface = createSurface({
      agent: 'claude',
      reportedValues: { model: 'opus' },
      persistSelection
    })

    surface.recordOutgoingCommand('/effort ultracode')

    expect(selectCurrentValue(surface, 'effort')).toBe(CLAUDE_ULTRACODE_EFFORT)
    expect(persistSelection).not.toHaveBeenCalled()
  })

  it('keeps Ultracode across xhigh reports and accepts a later high report', async () => {
    const surface = createSurface({ agent: 'claude', reportedValues: { model: 'opus' } })

    await surface.setOption('effort', CLAUDE_ULTRACODE_EFFORT)
    surface.reportSessionOptions({ model: 'opus', effort: 'xhigh' }, Date.now() + 60_000)
    expect(selectCurrentValue(surface, 'effort')).toBe(CLAUDE_ULTRACODE_EFFORT)

    surface.reportSessionOptions({ model: 'opus', effort: 'high' }, Date.now() + 120_000)
    expect(selectCurrentValue(surface, 'effort')).toBe('high')
  })

  it('does not add Ultracode to Codex effort choices', () => {
    const surface = createSurface({ agent: 'codex', reportedValues: { model: 'gpt-5.6-sol' } })

    expect(selectChoiceValues(surface, 'effort')).toContain('ultra')
    expect(selectChoiceValues(surface, 'effort')).not.toContain(CLAUDE_ULTRACODE_EFFORT)
  })

  it('renders the Ultracode option and description in the selector', () => {
    const surface = createSurface({ agent: 'claude', reportedValues: { model: 'opus' } })

    render(
      React.createElement(NativeChatSessionOptionPickers, {
        surface,
        snapshot: surface.getSnapshot(),
        isWorking: false,
        pickerRequest: { id: 'effort', sequence: 1 }
      })
    )

    expect(screen.getByText('Ultracode')).toBeTruthy()
    expect(
      screen.getByText('Extra high effort with multi-agent workflows · this session only')
    ).toBeTruthy()
  })
})
