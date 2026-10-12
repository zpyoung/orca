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
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))

import { AgentComposerField } from './AgentComposerField'

// A field-only render needs no live IME gesture; every hook is inert here.
const stubImeEnterGesture = {
  isComposing: () => false,
  ownsKeyDown: () => false,
  onKeyUp: () => {},
  onCompositionEnd: () => {},
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
      draftScopeKey="pane-1"
      textareaRef={createRef<HTMLTextAreaElement>()}
      draft=""
      disabled={false}
      hasPty
      canSend
      layout={layout}
      autocomplete={{ mode: 'none' }}
      activeSuggestion={0}
      notices={[]}
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
      onChooseMentionFile={vi.fn()}
      mentionFiles={{ files: [], loading: false, failed: false }}
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

  const card = document.querySelector('.border-chat-composer-border') as HTMLElement
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
    for (const className of ['mx-auto', 'max-w-(--chat-content-max-width)']) {
      expect(widthWrapper).not.toHaveClass(className)
    }
    expect(widthWrapper).toHaveClass('w-full')
    expect(card).toHaveClass('rounded-none')
    expect(card).not.toHaveClass('rounded-xl')
  })

  it('keeps the centered padded card in the chat layout', () => {
    const { widthWrapper, paddingWrapper, card } = renderField()

    expect(paddingWrapper).toHaveClass('px-3', 'pt-2', 'pb-4', 'sm:px-4')
    expect(widthWrapper).toHaveClass('mx-auto', 'max-w-(--chat-content-max-width)')
    expect(card).toHaveClass('rounded-xl')
    expect(card).not.toHaveClass('rounded-none')
  })
})
