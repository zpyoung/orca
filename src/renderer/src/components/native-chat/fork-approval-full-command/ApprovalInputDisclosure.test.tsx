// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  // interpolate like the real translate, or the truncation note asserts its own placeholders
  translate: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
    vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(vars[name] ?? '')) : fallback
}))

import { ApprovalInputDisclosure } from './ApprovalInputDisclosure'
import type { ChatApproval } from '../native-chat-interactive-prompt'

const OPTIONS = [
  { label: 'Allow', send: '1' },
  { label: 'Deny', send: '' }
]

function approval(fields: Partial<ChatApproval>): ChatApproval {
  return { title: 'Allow Bash?', options: OPTIONS, ...fields }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ApprovalInputDisclosure', () => {
  it('renders nothing without a detail preview', () => {
    const { container } = render(<ApprovalInputDisclosure approval={approval({})} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers no expander when the preview is the whole command', () => {
    render(<ApprovalInputDisclosure approval={approval({ detail: 'git status' })} />)
    expect(screen.getByText('git status')).toBeInTheDocument()
    expect(screen.queryByText('Show full command')).not.toBeInTheDocument()
  })

  it('swaps the cut preview for the whole command and back', () => {
    render(
      <ApprovalInputDisclosure
        approval={approval({
          detail: 'git commit -m "a…',
          full: 'git commit -m "a\nsecond line"',
          fullField: 'command'
        })}
      />
    )
    expect(screen.queryByText(/second line/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Show full command'))
    expect(screen.getByText(/second line/)).toBeInTheDocument()
    expect(screen.queryByText('git commit -m "a…')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Hide full command'))
    expect(screen.getByText('git commit -m "a…')).toBeInTheDocument()
  })

  it('labels the expander for the field the input came from', () => {
    render(
      <ApprovalInputDisclosure
        approval={approval({
          detail: 'https://example…',
          full: 'https://example.com/x',
          fullField: 'url'
        })}
      />
    )
    expect(screen.getByText('Show full input')).toBeInTheDocument()
  })

  it('reports the expanded state to assistive tech', () => {
    render(
      <ApprovalInputDisclosure
        approval={approval({ detail: 'a…', full: 'abc', fullField: 'command' })}
      />
    )
    const toggle = screen.getByRole('button', { name: 'Show full command' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide full command' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('copies the whole command, not the preview', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    // @ts-expect-error test double for the preload surface this button uses
    window.api = { ui: { writeClipboardText } }

    render(
      <ApprovalInputDisclosure
        approval={approval({ detail: 'rm -rf …', full: 'rm -rf /tmp/build', fullField: 'command' })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    expect(writeClipboardText).toHaveBeenCalledWith('rm -rf /tmp/build')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('drops the "full" wording and states the shortfall when the text was cut', () => {
    render(
      <ApprovalInputDisclosure
        approval={approval({
          detail: 'rm -rf …',
          full: 'rm -rf /tmp/build',
          fullField: 'command',
          fullLength: 9421
        })}
      />
    )
    expect(screen.queryByText('Show full command')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Show command'))
    expect(screen.getByText('Truncated — showing 17 of 9,421 characters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy truncated text' })).toBeInTheDocument()
  })

  it('claims no completeness for a cut non-command input either', () => {
    render(
      <ApprovalInputDisclosure
        approval={approval({
          detail: 'https://ex…',
          full: 'https://example.com/x',
          fullField: 'url',
          fullLength: 900
        })}
      />
    )
    expect(screen.getByText('Show input')).toBeInTheDocument()
  })

  it('offers no expander when the relay compacted the input down to the preview', () => {
    render(
      <ApprovalInputDisclosure
        approval={approval({
          detail: 'git comm',
          full: 'git comm',
          fullField: 'command',
          fullLength: 4200
        })}
      />
    )
    expect(screen.queryByText('Show command')).not.toBeInTheDocument()
    expect(screen.queryByText('Show full command')).not.toBeInTheDocument()
    // nothing left to expand into, so the preview itself is the clipped text
    expect(screen.getByText('Truncated — showing 8 of 4,200 characters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy truncated text' })).toBeInTheDocument()
  })

  it('copies the preview when that is all the host sent', () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    // @ts-expect-error test double for the preload surface this button uses
    window.api = { ui: { writeClipboardText } }

    render(<ApprovalInputDisclosure approval={approval({ detail: 'git status' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    expect(writeClipboardText).toHaveBeenCalledWith('git status')
  })
})
