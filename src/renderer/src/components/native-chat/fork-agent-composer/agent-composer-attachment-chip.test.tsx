// @vitest-environment happy-dom

/** The attachment chip shows the image the user attached, not a stand-in icon.
 *  Loading it goes through the editor's local-image IPC reader, so the chip's
 *  contract is: label stays, thumbnail replaces the icon once the read lands. */

import '@testing-library/jest-dom/vitest'

import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentComposerImageAttachment } from './AgentComposerField'

const loadLocalImageAbsolutePath = vi.hoisted(() => vi.fn())

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  loadLocalImageAbsolutePath,
  onImageCacheInvalidated: () => () => {}
}))

vi.mock('./AgentComposerActions', () => ({
  AgentComposerActions: () => <div data-testid="composer-actions" />
}))

vi.mock('../NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))

import { AgentComposerField } from './AgentComposerField'

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { authorizeExternalPath: vi.fn(() => Promise.resolve()) } }
  })
  loadLocalImageAbsolutePath.mockResolvedValue('blob:orca/shot')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderFieldWithAttachments(imageAttachments: AgentComposerImageAttachment[]): void {
  render(
    <AgentComposerField
      terminalTabId="tab-1"
      paneKey="pane-1"
      textareaRef={createRef<HTMLTextAreaElement>()}
      draft=""
      disabled={false}
      hasPty
      canSend
      autocomplete={{ mode: 'none' }}
      activeSuggestion={0}
      notice={null}
      imageAttachments={imageAttachments}
      sendButtonDisabled={false}
      isWorking={false}
      attachDisabled={false}
      dictationDisabled={false}
      isDictating={false}
      isDictationHoldMode={false}
      onDraftChange={vi.fn()}
      onTextareaSelect={vi.fn()}
      onKeyDown={vi.fn()}
      onCompositionStart={vi.fn()}
      onCompositionEnd={vi.fn()}
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
}

describe('agent composer attachment chip', () => {
  it('shows a thumbnail of a dropped image beside its filename', async () => {
    renderFieldWithAttachments([{ id: 'a', path: '/local/shot.png' }])

    const thumbnail = await screen.findByAltText('shot.png')
    expect(thumbnail).toHaveAttribute('src', 'blob:orca/shot')
    expect(screen.getByText('shot.png')).toBeInTheDocument()
  })

  it('labels a pasted image thumbnail with the friendly label, not its temp filename', async () => {
    renderFieldWithAttachments([{ id: 'a', path: '/tmp/orca-paste-1700000000000-abc.png' }])

    expect(await screen.findByAltText('Pasted image')).toBeInTheDocument()
    expect(screen.queryByText(/orca-paste-/)).not.toBeInTheDocument()
  })

  it('reads each attachment once, from its own path', async () => {
    renderFieldWithAttachments([
      { id: 'a', path: '/local/one.png' },
      { id: 'b', path: '/local/two.png' }
    ])

    await screen.findByAltText('one.png')
    await screen.findByAltText('two.png')
    expect(loadLocalImageAbsolutePath).toHaveBeenCalledTimes(2)
    expect(loadLocalImageAbsolutePath).toHaveBeenCalledWith('/local/one.png')
    expect(loadLocalImageAbsolutePath).toHaveBeenCalledWith('/local/two.png')
  })
})
