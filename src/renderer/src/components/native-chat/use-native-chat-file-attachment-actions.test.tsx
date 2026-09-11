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

const SCOPE_KEY = 'tab-1:pane-1'

function composerDrop(scopeKey?: string): NativeFileDropPayload {
  return {
    paths: ['/tmp/a.png'],
    target: NATIVE_FILE_DROP_TARGET.composer,
    ...(scopeKey ? { scopeKey } : {})
  }
}

describe('useNativeChatFileAttachmentActions', () => {
  it('attaches a drop addressed to this composer', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(SCOPE_KEY, attach))

    emitDrop(composerDrop(SCOPE_KEY))
    expect(attach).toHaveBeenCalledWith(['/tmp/a.png'])
  })

  it('ignores a drop addressed to a different composer', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(SCOPE_KEY, attach))

    emitDrop(composerDrop('tab-1:pane-2'))
    expect(attach).not.toHaveBeenCalled()
  })

  it('ignores an unaddressed drop rather than attaching it everywhere', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(SCOPE_KEY, attach))

    emitDrop(composerDrop())
    expect(attach).not.toHaveBeenCalled()
  })

  it('ignores drops aimed at a non-composer surface', () => {
    const attach = vi.fn()
    renderHook(() => useNativeChatFileAttachmentActions(SCOPE_KEY, attach))

    emitDrop({ paths: ['/tmp/a.png'], target: NATIVE_FILE_DROP_TARGET.editor })
    expect(attach).not.toHaveBeenCalled()
  })
})
