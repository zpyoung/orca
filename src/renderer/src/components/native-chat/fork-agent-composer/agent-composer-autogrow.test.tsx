// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-composer-autogrow.test.tsx
// FORK-COPY-SHA: 1c6ac8c3c4d2c3dec2cb5966d225ca2a0e0471d3
// @vitest-environment happy-dom

/** happy-dom verifies the CSS sizing contract; app validation covers actual growth up to eight lines. */

import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
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
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

afterEach(() => cleanup())

function TestField({ draft }: { draft: string }): React.JSX.Element {
  const imeEnterGesture = useImeEnterGestureOwnership()
  return (
    <AgentComposerField
      terminalTabId="tab-1"
      draftScopeKey="pane-test"
      textareaRef={createRef<HTMLTextAreaElement>()}
      draft={draft}
      disabled={false}
      hasPty
      canSend
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
      imeEnterGesture={imeEnterGesture}
      onDraftChange={vi.fn()}
      onTextareaSelect={vi.fn()}
      onKeyDown={vi.fn()}
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
}

function renderField(draft: string): HTMLTextAreaElement {
  render(<TestField draft={draft} />)
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('agent composer autogrow', () => {
  it('sizes the textarea from its content instead of staying at rows={2}', () => {
    expect(renderField('').className).toContain('[field-sizing:content]')
  })

  it('caps growth at 8 lines plus the py-1 padding box', () => {
    // An lh-relative cap follows text tokens instead of a fixed pixel height.
    const textarea = renderField('a\n'.repeat(20))
    expect(textarea.className).toContain('max-h-[calc(8lh+0.5rem)]')
    expect(textarea.className).not.toContain('max-h-28')
  })

  it('keeps the sleek scrollbar for the overflow past the cap', () => {
    expect(renderField('a\n'.repeat(20)).className).toContain('scrollbar-sleek')
  })

  it('keeps the touch-target minimum heights', () => {
    const textarea = renderField('')
    expect(textarea.className).toContain('min-h-12')
    expect(textarea.className).toContain('pointer-coarse:min-h-14')
  })

  it('does not pin an inline height that a resize could leave stale', () => {
    // An inline height updated only on text changes would survive pane rewrapping incorrectly.
    expect(renderField('a\n'.repeat(6)).style.height).toBe('')
  })

  it('layers the native caret and selection over the Markdown mirror', () => {
    const textarea = renderField('**bold**')
    const overlay = textarea.parentElement?.querySelector('[data-composer-markdown-overlay]')

    expect(overlay).not.toBeNull()
    expect(textarea.className).toContain('text-transparent')
    expect(textarea.className).toContain('caret-foreground')
    expect(textarea.className).toContain('selection:bg-ring/35')
  })
})
