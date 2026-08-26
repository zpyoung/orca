// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
  getRetained: vi.fn(),
  resend: vi.fn(),
  release: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    warning: mocks.warning,
    success: mocks.success,
    error: mocks.error,
    dismiss: mocks.dismiss
  }
}))
vi.mock('@/lib/fork-session-handoff/launch-session-handoff', () => ({
  getRetainedHandoffBrief: mocks.getRetained,
  resendRetainedHandoffBrief: mocks.resend,
  dismissRetainedHandoffBrief: mocks.release
}))

import { notifyHandoffDelivery } from './handoff-delivery-toast'

describe('handoff delivery toast', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('requires confirmation for an unobservable resend and releases content on dismiss', async () => {
    mocks.getRetained.mockReturnValue({ tabId: 'tab-1', briefText: 'brief' })
    mocks.resend.mockResolvedValue('resent')

    notifyHandoffDelivery('tab-1', Promise.resolve('unobservable'))
    await act(async () => {})

    const options = mocks.warning.mock.calls[0][1] as {
      description: React.ReactNode
      onDismiss: () => void
      duration: number
    }
    expect(options.duration).toBe(Infinity)
    options.onDismiss()
    expect(mocks.release).toHaveBeenCalledWith('tab-1')

    act(() => root.render(options.description))
    const resend = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Resend brief'
    )
    act(() => resend?.click())
    expect(mocks.resend).not.toHaveBeenCalled()
    expect(container.textContent).toContain('may already have arrived')

    const sendAgain = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Send again'
    )
    await act(async () => sendAgain?.click())
    expect(mocks.resend).toHaveBeenCalledWith('tab-1')
    expect(mocks.dismiss).toHaveBeenCalledWith('fork-session-handoff-delivery:tab-1')
  })

  it('keeps a failed evidence-backed retry actionable when content remains', async () => {
    mocks.getRetained.mockReturnValue({ tabId: 'tab-2', briefText: 'brief' })

    notifyHandoffDelivery('tab-2', Promise.resolve('not-delivered'))
    await act(async () => {})

    expect(mocks.warning).toHaveBeenCalledWith(
      'Brief delivery and the automatic retry failed.',
      expect.objectContaining({ duration: Infinity })
    )
  })
})
