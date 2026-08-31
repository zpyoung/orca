// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_FILE_DROP_TARGET,
  type NativeFileDropPayload
} from '../../../../shared/native-file-drop'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'

let emitDrop: (payload: NativeFileDropPayload) => void

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onFileDrop: (listener: (payload: NativeFileDropPayload) => void) => {
          emitDrop = listener
          return () => {}
        }
      },
      shell: { pickAttachment: vi.fn() }
    }
  })
})

afterEach(() => vi.clearAllMocks())

const IDENTITY = { terminalTabId: 'tab-1', paneKey: 'pane-1' }

function composerDrop(routing: { tabId?: string; paneLeafId?: string }): NativeFileDropPayload {
  return { paths: ['/tmp/a.png'], target: NATIVE_FILE_DROP_TARGET.composer, ...routing }
}

describe('useNativeChatFileAttachmentActions', () => {
  it('attaches a drop addressed to this composer', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(attach, IDENTITY))

    emitDrop(composerDrop({ tabId: 'tab-1', paneLeafId: 'pane-1' }))
    expect(attach).toHaveBeenCalledWith(['/tmp/a.png'])
  })

  it('ignores a drop addressed to a different composer on the same tab', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(attach, IDENTITY))

    emitDrop(composerDrop({ tabId: 'tab-1', paneLeafId: 'pane-2' }))
    expect(attach).not.toHaveBeenCalled()
  })

  it('ignores a drop addressed to a composer on another tab', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(attach, IDENTITY))

    emitDrop(composerDrop({ tabId: 'tab-2', paneLeafId: 'pane-1' }))
    expect(attach).not.toHaveBeenCalled()
  })

  it('still attaches an unaddressed drop so a producer without pane identity keeps working', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(attach, IDENTITY))

    emitDrop(composerDrop({}))
    expect(attach).toHaveBeenCalledWith(['/tmp/a.png'])
  })

  it('ignores drops aimed at a non-composer surface', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(attach, IDENTITY))

    emitDrop({ paths: ['/tmp/a.png'], target: NATIVE_FILE_DROP_TARGET.editor })
    expect(attach).not.toHaveBeenCalled()
  })
})
