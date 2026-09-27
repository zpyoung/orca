// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./AgentComposerActions', () => ({
  AgentComposerActions: () => <div data-testid="composer-actions" />
}))

vi.mock('../NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))

vi.mock('../fork-native-chat-width/use-native-chat-width', () => ({
  useNativeChatWidthClassName: () => 'max-w-4xl'
}))

import { AgentComposerField } from './AgentComposerField'

// A field-only render needs no live IME gesture; every hook is inert here.
const stubImeEnterGesture = {
  isComposing: () => false,
  ownsKeyDown: () => false,
  onKeyUp: () => {},
  reset: () => {},
  setComposing: () => {}
}

afterEach(() => cleanup())

function renderField(layout?: 'dock'): {
  widthWrapper: HTMLElement
  paddingWrapper: HTMLElement
  card: HTMLElement
} {
  render(
    <AgentComposerField
      terminalTabId="tab-1"
      paneKey="pane-1"
      textareaRef={createRef<HTMLTextAreaElement>()}
      draft=""
      disabled={false}
      hasPty
      canSend
      layout={layout}
      autocomplete={{ mode: 'none' }}
      activeSuggestion={0}
      notice={null}
      imageAttachments={[]}
      sendButtonDisabled={false}
      isWorking={false}
      attachDisabled={false}
      dictationDisabled={false}
      isDictating={false}
      isDictationHoldMode={false}
      onDraftChange={vi.fn()}
      onTextareaSelect={vi.fn()}
      onKeyDown={vi.fn()}
      imeEnterGesture={stubImeEnterGesture}
      onImeSettled={vi.fn()}
      onPaste={vi.fn()}
      pickerListboxId="picker"
      onChoosePickerItem={vi.fn()}
      onRetrySkills={vi.fn()}
      onAcceptMention={vi.fn()}
      onRemoveImageAttachment={vi.fn()}
      onAttach={vi.fn()}
      onDictationToggle={vi.fn()}
      onDictationHoldStart={vi.fn()}
      onDictationHoldEnd={vi.fn()}
      onSend={vi.fn()}
      sessionOptionsSurface={null}
      sessionOptionsSnapshot={[]}
    />
  )

  const card = document.querySelector('[data-native-file-drop-target]') as HTMLElement
  const widthWrapper = card.parentElement as HTMLElement
  const paddingWrapper = widthWrapper.parentElement as HTMLElement
  return { widthWrapper, paddingWrapper, card }
}

describe('agent composer dock layout', () => {
  it('fills the dock without outer spacing or rounded corners', () => {
    const { widthWrapper, paddingWrapper, card } = renderField('dock')

    for (const className of ['px-3', 'pt-2', 'pb-2', 'pb-4', 'sm:px-4']) {
      expect(paddingWrapper).not.toHaveClass(className)
    }
    for (const className of ['mx-auto', 'max-w-4xl']) {
      expect(widthWrapper).not.toHaveClass(className)
    }
    expect(widthWrapper).toHaveClass('w-full')
    expect(card).toHaveClass('rounded-none')
    expect(card).not.toHaveClass('rounded-lg')
  })

  it('keeps the centered padded card in the chat layout', () => {
    const { widthWrapper, paddingWrapper, card } = renderField()

    expect(paddingWrapper).toHaveClass('px-3', 'pt-2', 'pb-4', 'sm:px-4')
    expect(widthWrapper).toHaveClass('mx-auto', 'max-w-4xl')
    expect(card).toHaveClass('rounded-lg')
    expect(card).not.toHaveClass('rounded-none')
  })
})
