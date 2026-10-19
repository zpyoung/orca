import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ write: vi.fn(), acceptance: vi.fn(), delivery: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputAcceptance: io.acceptance,
  sendRuntimePtyInputDelivery: io.delivery
}))
import {
  sendNativeChatMessage,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-runtime-send'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine
} from '../terminal-pane/terminal-input-quarantine'

// The fork's send path is scoped to a terminal tab so reattach quarantine can invalidate it.
const TARGET: NativeChatResolvedTarget = { terminalTabId: 'tab', ptyId: 'pane' }

beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  io.write.mockReset().mockReturnValue(true)
  io.acceptance.mockReset().mockResolvedValue(true)
  io.delivery.mockReset().mockResolvedValue('accepted')
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  _resetTerminalInputQuarantineForTests()
  vi.useRealTimers()
})
it('observes a refused write, skips Enter, and releases the queue for the next user action', async () => {
  const rejected = vi.fn()
  io.delivery.mockResolvedValueOnce('refused')
  sendNativeChatMessage(TARGET, 'refused', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(rejected).toHaveBeenCalledOnce()
  expect(io.delivery.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('refused')
  ])
  sendNativeChatMessage(TARGET, 'next', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(io.delivery.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('refused'),
    buildNativeChatPasteBytes('next'),
    NATIVE_CHAT_SUBMIT
  ])
})
it('reports a lost acknowledgment once as unconfirmed, never as rejection, and still submits', async () => {
  const rejected = vi.fn()
  const unconfirmed = vi.fn()
  io.delivery.mockResolvedValueOnce('unverifiable')
  io.delivery.mockResolvedValueOnce('unverifiable')
  sendNativeChatMessage(TARGET, 'uncertain', {
    onWriteRejected: rejected,
    onWriteUnconfirmed: unconfirmed
  })
  await vi.advanceTimersByTimeAsync(120000)
  expect(rejected).not.toHaveBeenCalled()
  expect(unconfirmed).toHaveBeenCalledOnce()
  expect(io.delivery.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('uncertain'),
    NATIVE_CHAT_SUBMIT
  ])
})
it('serializes rapid sends through their acknowledged Enter and preserves the paste delay', async () => {
  const rejected = vi.fn()
  sendNativeChatMessage(TARGET, 'one', { onWriteRejected: rejected })
  sendNativeChatMessage(TARGET, 'two', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(499)
  expect(io.delivery).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(501)
  expect(io.delivery.mock.calls.map((call) => call[1])).toEqual([
    buildNativeChatPasteBytes('one'),
    NATIVE_CHAT_SUBMIT,
    buildNativeChatPasteBytes('two'),
    NATIVE_CHAT_SUBMIT
  ])
})

it.each(['accepted', 'refused', 'unknown'] as const)(
  'reports a pasted answer as acknowledged only after %s settlement',
  async (outcome) => {
    const settled = vi.fn()
    if (outcome === 'refused') {
      io.delivery.mockResolvedValueOnce('refused')
    } else if (outcome === 'unknown') {
      io.delivery.mockResolvedValueOnce('unverifiable')
    }
    sendNativeChatMessage(TARGET, 'answer', { onDeliverySettled: settled })
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === 'accepted')
    expect(io.delivery.mock.calls.map((call) => call[1])).toEqual(
      outcome === 'refused'
        ? [buildNativeChatPasteBytes('answer')]
        : [buildNativeChatPasteBytes('answer'), NATIVE_CHAT_SUBMIT]
    )
  }
)

it('ignores a pasted answer acknowledgment after cancellation', async () => {
  let acknowledge: (delivery: 'accepted') => void = () => {}
  io.delivery.mockReturnValueOnce(
    new Promise<'accepted'>((resolve) => {
      acknowledge = resolve
    })
  )
  const settled = vi.fn()
  const handle = sendNativeChatMessage(TARGET, 'answer', { onDeliverySettled: settled })
  // The fork dispatches the body from a microtask; cancel once the write is in flight.
  await vi.advanceTimersByTimeAsync(0)
  handle.cancel()
  acknowledge('accepted')
  await vi.advanceTimersByTimeAsync(1000)
  expect(settled).not.toHaveBeenCalled()
  expect(io.delivery).toHaveBeenCalledOnce()
})

it('reports a send refused by reattach quarantine as rejected and unacknowledged', async () => {
  const rejected = vi.fn()
  const settled = vi.fn()
  armTerminalInputQuarantine(TARGET.terminalTabId)
  sendNativeChatMessage(TARGET, 'quarantined', {
    onWriteRejected: rejected,
    onDeliverySettled: settled
  })
  await vi.advanceTimersByTimeAsync(1000)
  expect(rejected).toHaveBeenCalledOnce()
  expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  expect(io.delivery).not.toHaveBeenCalled()
})
