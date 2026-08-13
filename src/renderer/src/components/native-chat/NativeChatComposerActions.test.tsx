// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children: ReactNode
    variant?: string
    size?: string
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))

import {
  NativeChatComposerActions,
  type NativeChatComposerActionsProps
} from './NativeChatComposerActions'

afterEach(() => cleanup())

function renderActions(
  overrides: Partial<NativeChatComposerActionsProps> = {}
): { onSend: ReturnType<typeof vi.fn>; onStop: ReturnType<typeof vi.fn> } {
  const onSend = vi.fn()
  const onStop = vi.fn()
  render(
    <NativeChatComposerActions
      attachDisabled={false}
      dictationDisabled={false}
      sendDisabled={false}
      isWorking={false}
      isDictating={false}
      isDictationHoldMode={false}
      onAttach={vi.fn()}
      onDictationToggle={vi.fn()}
      onDictationHoldStart={vi.fn()}
      onDictationHoldEnd={vi.fn()}
      onSend={onSend}
      onStop={onStop}
      sessionOptionsSurface={null}
      sessionOptionsSnapshot={[]}
      {...overrides}
    />
  )
  return { onSend, onStop }
}

describe('NativeChatComposerActions', () => {
  it('places session option pickers immediately beside dictation', () => {
    render(
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        isWorking={false}
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={vi.fn()}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    )

    const pickers = screen.getByTestId('session-option-pickers')
    const dictation = screen.getByRole('button', { name: 'Start dictation' })
    expect(pickers.nextElementSibling).toBe(dictation)
  })

  it('renders Send labeled "Send" and never flips it to Stop, whether idle or working', () => {
    renderActions({ isWorking: false })
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    cleanup()

    renderActions({ isWorking: true })
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('renders Stop only while isWorking is true', () => {
    renderActions({ isWorking: false })
    expect(screen.queryByRole('button', { name: 'Stop the agent' })).not.toBeInTheDocument()
    cleanup()

    renderActions({ isWorking: true })
    expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeInTheDocument()
  })

  it('clicking Send calls onSend and not onStop while isWorking is true', () => {
    const { onSend, onStop } = renderActions({ isWorking: true })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('clicking Stop calls onStop and not onSend', () => {
    const { onSend, onStop } = renderActions({ isWorking: true })
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps Stop enabled and clickable when sendDisabled is true', () => {
    const { onStop } = renderActions({ isWorking: true, sendDisabled: true })
    const stopButton = screen.getByRole('button', { name: 'Stop the agent' })
    expect(stopButton).not.toBeDisabled()
    fireEvent.click(stopButton)
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
