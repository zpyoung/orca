// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import type { NativeChatComposerHandle } from './NativeChatComposer'

const CLIPBOARD_TEXT = 'clipboard payload'

// An image-only clipboard reads back as empty text; that is the bridge's only
// signal that the paste was an image, so tests drive it through this mock.
const readClipboardText = vi.fn(() => Promise.resolve(CLIPBOARD_TEXT))

beforeAll(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { readClipboardText: () => readClipboardText() } }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  readClipboardText.mockResolvedValue(CLIPBOARD_TEXT)
})

function composerHandle(): NativeChatComposerHandle {
  return {
    focus: vi.fn(() => true),
    insertTypedText: vi.fn(() => true),
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn()
  }
}

function Harness({
  composer,
  answerInput
}: {
  composer: NativeChatComposerHandle | null
  answerInput: boolean
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle | null>(composer)
  composerRef.current = composer
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  useNativeChatPasteBridge({ rootRef, composerRef, questionAnswerInputRef })
  return (
    <div ref={rootRef}>
      <textarea data-testid="composer-field" />
      {answerInput ? <input ref={questionAnswerInputRef} data-testid="answer-input" /> : null}
    </div>
  )
}

function dispatchAppMenuPaste(): boolean {
  const event = new CustomEvent(APP_MENU_PASTE_EVENT, { bubbles: false, cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('useNativeChatPasteBridge app-menu paste routing', () => {
  it('pastes into the composer when it is the only target', () => {
    const composer = composerHandle()
    render(<Harness composer={composer} answerInput={false} />)
    screen.getByTestId('composer-field').focus()

    expect(dispatchAppMenuPaste()).toBe(true)
    expect(composer.pasteFromClipboard).toHaveBeenCalledOnce()
  })

  it('pastes into the answer input when the composer is unmounted', async () => {
    render(<Harness composer={null} answerInput={true} />)
    const input = screen.getByTestId('answer-input') as HTMLInputElement
    input.focus()

    expect(dispatchAppMenuPaste()).toBe(true)
    await waitFor(() => expect(input.value).toBe(CLIPBOARD_TEXT))
  })

  it('prefers a focused answer input over a composer that is still mounted', async () => {
    const composer = composerHandle()
    render(<Harness composer={composer} answerInput={true} />)
    const input = screen.getByTestId('answer-input') as HTMLInputElement
    input.focus()

    expect(dispatchAppMenuPaste()).toBe(true)
    await waitFor(() => expect(input.value).toBe(CLIPBOARD_TEXT))
    expect(composer.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('keeps paste on the composer when focus is outside the answer input', () => {
    const composer = composerHandle()
    render(<Harness composer={composer} answerInput={true} />)
    screen.getByTestId('composer-field').focus()

    expect(dispatchAppMenuPaste()).toBe(true)
    expect(composer.pasteFromClipboard).toHaveBeenCalledOnce()
    expect((screen.getByTestId('answer-input') as HTMLInputElement).value).toBe('')
  })

  it('attaches an image-only clipboard to the composer instead of dropping it', async () => {
    readClipboardText.mockResolvedValue('')
    const composer = composerHandle()
    render(<Harness composer={composer} answerInput={true} />)
    const input = screen.getByTestId('answer-input') as HTMLInputElement
    input.focus()

    expect(dispatchAppMenuPaste()).toBe(true)
    await waitFor(() => expect(composer.pasteFromClipboard).toHaveBeenCalledOnce())
    expect(input.value).toBe('')
  })

  it('does nothing when the clipboard is empty and no composer is mounted', async () => {
    readClipboardText.mockResolvedValue('')
    render(<Harness composer={null} answerInput={true} />)
    const input = screen.getByTestId('answer-input') as HTMLInputElement
    input.focus()

    expect(dispatchAppMenuPaste()).toBe(true)
    await waitFor(() => expect(readClipboardText).toHaveBeenCalledOnce())
    expect(input.value).toBe('')
  })

  it('leaves the event unclaimed when neither target is mounted', () => {
    render(<Harness composer={null} answerInput={false} />)
    screen.getByTestId('composer-field').focus()

    expect(dispatchAppMenuPaste()).toBe(false)
  })
})

describe('useNativeChatPasteBridge DOM paste routing', () => {
  it('hands a paste event inside the pane to the composer', () => {
    const composer = composerHandle()
    render(<Harness composer={composer} answerInput={false} />)

    const field = screen.getByTestId('composer-field')
    field.dispatchEvent(new Event('paste', { bubbles: true }))
    expect(composer.handlePasteEvent).toHaveBeenCalledOnce()
  })

  // A clipboard image has nowhere to go in the answer input, so it keeps
  // attaching to the composer beside the card rather than being dropped; text
  // falls through the composer's handler untouched either way.
  it('still routes a paste event at the answer input to the composer', () => {
    const composer = composerHandle()
    render(<Harness composer={composer} answerInput={true} />)

    const input = screen.getByTestId('answer-input')
    input.dispatchEvent(new Event('paste', { bubbles: true }))
    expect(composer.handlePasteEvent).toHaveBeenCalledOnce()
  })
})
