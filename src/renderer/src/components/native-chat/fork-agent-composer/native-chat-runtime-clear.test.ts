import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputAcceptance = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args),
  sendRuntimePtyInputAcceptance: (...args: unknown[]) => sendRuntimePtyInputAcceptance(...args)
}))

import {
  AGENT_TUI_CLEAR_INPUT_MAX,
  buildAgentTuiClearInput
} from '../../../../../shared/agent-tui-input-clear'
import type { RuntimeSettings } from '../native-chat-runtime-send'
import {
  clearThenWrite,
  clearUnsubmittedAgentInput,
  NATIVE_CHAT_CLEAR_CHUNK_GAP_MS,
  NATIVE_CHAT_CLEAR_CONFIRM_MS
} from './native-chat-runtime-clear'

// Claude Code treats a single stdin read of this many bytes as a paste and keeps
// the control bytes as literal text (measured against v2.1.280–2.1.283).
const CLAUDE_PASTE_READ_BYTES = 64

const SETTINGS: RuntimeSettings = {}
const PTY = 'pty-clear'
const LONG_DRAFT_CLEAR = buildAgentTuiClearInput(30)

const acceptedWrites = (): string[] =>
  sendRuntimePtyInputAcceptance.mock.calls.map((call) => String(call[2]))

// A pty read can coalesce two back-to-back writes, so no adjacent pair may reach
// the paste threshold either.
const expectBelowPasteThreshold = (chunks: string[]): void => {
  for (let index = 0; index < chunks.length; index += 1) {
    const pair = chunks[index]! + (chunks[index + 1] ?? '')
    expect(pair.length).toBeLessThan(CLAUDE_PASTE_READ_BYTES)
  }
}

const delay = (ms: number, fn: () => void): void => {
  setTimeout(fn, ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  sendRuntimePtyInput.mockReset()
  sendRuntimePtyInput.mockReturnValue(true)
  sendRuntimePtyInputAcceptance.mockReset()
  sendRuntimePtyInputAcceptance.mockResolvedValue(true)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('clearThenWrite', () => {
  it('delivers a long-draft clear in sub-paste writes before the body', async () => {
    const writeBody = vi.fn()
    clearThenWrite(SETTINGS, PTY, { clearInput: LONG_DRAFT_CLEAR }, delay, writeBody, vi.fn())
    await vi.runAllTimersAsync()

    expect(acceptedWrites().join('')).toBe(LONG_DRAFT_CLEAR)
    expectBelowPasteThreshold(acceptedWrites())
    expect(writeBody).toHaveBeenCalledOnce()
  })

  it('delivers the maximal escalation in sub-paste writes when the line is not observed clear', async () => {
    const clearInput = buildAgentTuiClearInput(1)
    const writeBody = vi.fn()
    clearThenWrite(
      SETTINGS,
      PTY,
      { clearInput, confirmCleared: () => false },
      delay,
      writeBody,
      vi.fn()
    )
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_CLEAR_CONFIRM_MS)
    await vi.runAllTimersAsync()

    expect(acceptedWrites().join('')).toBe(clearInput + AGENT_TUI_CLEAR_INPUT_MAX)
    expectBelowPasteThreshold(acceptedWrites())
    expect(writeBody).toHaveBeenCalledOnce()
  })

  it('holds the body until the last clear chunk is written', async () => {
    const writeBody = vi.fn()
    clearThenWrite(SETTINGS, PTY, { clearInput: LONG_DRAFT_CLEAR }, delay, writeBody, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(writeBody).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_CLEAR_CHUNK_GAP_MS * 10)
    expect(writeBody).toHaveBeenCalledOnce()
  })

  it('rejects the send without writing the body when a later clear chunk is refused', async () => {
    sendRuntimePtyInputAcceptance.mockResolvedValueOnce(true).mockResolvedValue(false)
    const writeBody = vi.fn()
    const rejectSend = vi.fn()
    clearThenWrite(SETTINGS, PTY, { clearInput: LONG_DRAFT_CLEAR }, delay, writeBody, rejectSend)
    await vi.runAllTimersAsync()

    expect(writeBody).not.toHaveBeenCalled()
    expect(rejectSend).toHaveBeenCalledOnce()
  })
})

describe('clearUnsubmittedAgentInput', () => {
  it('delivers a long-draft cleanup clear in sub-paste writes', async () => {
    clearUnsubmittedAgentInput(SETTINGS, PTY, { clearInput: LONG_DRAFT_CLEAR })
    await vi.runAllTimersAsync()

    const writes = sendRuntimePtyInput.mock.calls.map((call) => String(call[2]))
    expect(writes.join('')).toBe(LONG_DRAFT_CLEAR)
    expectBelowPasteThreshold(writes)
  })
})
