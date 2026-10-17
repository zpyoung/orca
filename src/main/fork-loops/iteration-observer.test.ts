import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import {
  createIterationObserver,
  ITERATION_NO_BUSY_EDGE_SETTLE_MS,
  type IterationHookRow,
  type IterationSettlement
} from './iteration-observer'

const SENT_AT = 100_000

function wait(overrides: Partial<RuntimeTerminalWait> = {}): RuntimeTerminalWait {
  return {
    handle: 'term-1',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null,
    ...overrides
  }
}

function row(overrides: Partial<IterationHookRow> & { state: IterationHookRow['state'] }) {
  return { receivedAt: SENT_AT + 1_000, ...overrides }
}

function harness(options: { withLiveness?: boolean; withSubscribe?: boolean } = {}) {
  const rows: IterationHookRow[] = []
  const listeners = new Set<(statuses: { paneKey: string }[]) => void>()
  const hookSource = {
    getStatusSnapshotForPane: vi.fn(() => rows),
    ...(options.withSubscribe === false
      ? {}
      : {
          subscribeStatusChanges: vi.fn((listener: (statuses: { paneKey: string }[]) => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          })
        })
  }
  const runtime = {
    waitForTerminal: vi.fn(async (): Promise<RuntimeTerminalWait> => wait()),
    ...(options.withLiveness === false
      ? {}
      : {
          getPtyLivenessVerdict: vi.fn(
            (): { status: 'live'; ptyIds: string[] } | { status: 'exited' } | null => ({
              status: 'live',
              ptyIds: ['pty-1']
            })
          )
        })
  }
  const inputAttribution = {
    noteLoopWrite: vi.fn(),
    userInputSince: vi.fn(() => false),
    userIdleFor: vi.fn(() => true)
  }
  const callbacks = { onNeedsYou: vi.fn(), onResumed: vi.fn() }
  const controller = new AbortController()
  const observer = createIterationObserver({ runtime, hookSource, inputAttribution })
  const observe = (): Promise<IterationSettlement> =>
    observer.observeIteration({
      handle: 'term-1',
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      sentAt: SENT_AT,
      signal: controller.signal,
      ...callbacks
    })
  return { rows, listeners, hookSource, runtime, inputAttribution, callbacks, controller, observe }
}

// a row from before the send marks the pane as hook-reporting without counting as evidence
function hooked(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  h.rows.push(row({ state: 'waiting', receivedAt: SENT_AT - 5_000 }))
  return h
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(SENT_AT)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('iteration observer with hook rows', () => {
  it('settles after a working row then a waiting row, carrying the last message', async () => {
    const h = hooked()
    const result = h.observe()
    h.rows.splice(0, h.rows.length, row({ state: 'working', receivedAt: SENT_AT + 500 }))
    await advance(1_000)
    h.rows.splice(
      0,
      h.rows.length,
      row({ state: 'waiting', receivedAt: SENT_AT + 4_000, lastAssistantMessage: 'all done' })
    )
    await advance(1_000)

    await expect(result).resolves.toEqual({
      kind: 'settled',
      settledAt: SENT_AT + 2_000,
      lastAssistantMessage: 'all done'
    })
  })

  it('settles on a done row as well', async () => {
    const h = hooked()
    const result = h.observe()
    h.rows.splice(0, h.rows.length, row({ state: 'working', receivedAt: SENT_AT + 100 }))
    await advance(1_000)
    h.rows.splice(0, h.rows.length, row({ state: 'done', receivedAt: SENT_AT + 1_500 }))
    await advance(1_000)

    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('does not settle on an idle row that predates the send', async () => {
    const h = hooked()
    h.rows.push(row({ state: 'waiting', receivedAt: SENT_AT - 10_000 }))
    let settled = false
    const result = h.observe().then((value) => {
      settled = true
      return value
    })
    await advance(60_000)

    expect(settled).toBe(false)
    await advance(ITERATION_NO_BUSY_EDGE_SETTLE_MS)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('settles an iteration the agent ignored once no busy edge arrives in two minutes', async () => {
    const h = hooked()
    const result = h.observe()
    await advance(ITERATION_NO_BUSY_EDGE_SETTLE_MS)

    const settlement = await result
    expect(settlement).toEqual({
      kind: 'settled',
      settledAt: SENT_AT + ITERATION_NO_BUSY_EDGE_SETTLE_MS
    })
  })

  it('treats a turn that started after the send as a busy edge even when the working row was folded away', async () => {
    const h = hooked()
    const result = h.observe()
    h.rows.push(
      row({ state: 'waiting', receivedAt: SENT_AT + 3_000, turnStartedAt: SENT_AT + 500 })
    )
    await advance(1_000)

    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('ignores a session-boundary done row', async () => {
    const h = hooked()
    let settled = false
    const result = h.observe().then((value) => {
      settled = true
      return value
    })
    h.rows.push(row({ state: 'working', receivedAt: SENT_AT + 100 }))
    await advance(1_000)
    h.rows.splice(
      0,
      h.rows.length,
      row({ state: 'done', receivedAt: SENT_AT + 1_500, sessionBoundary: true })
    )
    await advance(5_000)

    expect(settled).toBe(false)
    h.rows.splice(0, h.rows.length, row({ state: 'waiting', receivedAt: SENT_AT + 7_000 }))
    await advance(1_000)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('holds an interrupted done row until the user has been idle', async () => {
    const h = hooked()
    let settled = false
    const result = h.observe().then((value) => {
      settled = true
      return value
    })
    h.rows.push(row({ state: 'working', receivedAt: SENT_AT + 100 }))
    await advance(1_000)
    h.rows.splice(
      0,
      h.rows.length,
      row({ state: 'done', receivedAt: SENT_AT + 1_500, interrupted: true })
    )
    await advance(10_000)

    expect(settled).toBe(false)
    await advance(20_000)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('holds the settle while the user is typing and releases it once they are idle', async () => {
    const h = hooked()
    h.inputAttribution.userInputSince.mockReturnValue(true)
    h.inputAttribution.userIdleFor.mockReturnValue(false)
    let settled = false
    const result = h.observe().then((value) => {
      settled = true
      return value
    })
    h.rows.push(row({ state: 'working', receivedAt: SENT_AT + 100 }))
    await advance(1_000)
    h.rows.splice(0, h.rows.length, row({ state: 'waiting', receivedAt: SENT_AT + 1_500 }))
    await advance(5_000)

    expect(settled).toBe(false)
    h.inputAttribution.userIdleFor.mockReturnValue(true)
    await advance(1_000)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
    expect(h.inputAttribution.userInputSince).toHaveBeenCalledWith('pty-1', SENT_AT)
  })

  it('reports a blocked row once, stops the no-busy-edge clock, and resumes on the next busy edge', async () => {
    const h = hooked()
    let settled = false
    const result = h.observe().then((value) => {
      settled = true
      return value
    })
    h.rows.push(row({ state: 'blocked', receivedAt: SENT_AT + 500 }))
    await advance(ITERATION_NO_BUSY_EDGE_SETTLE_MS * 2)

    expect(settled).toBe(false)
    expect(h.callbacks.onNeedsYou).toHaveBeenCalledTimes(1)
    expect(h.callbacks.onNeedsYou).toHaveBeenCalledWith('blocked-state')
    expect(h.callbacks.onResumed).not.toHaveBeenCalled()

    h.rows.splice(0, h.rows.length, row({ state: 'working', receivedAt: SENT_AT + 300_000 }))
    await advance(1_000)
    expect(h.callbacks.onResumed).toHaveBeenCalledTimes(1)

    h.rows.splice(0, h.rows.length, row({ state: 'waiting', receivedAt: SENT_AT + 310_000 }))
    await advance(1_000)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('reports a row carrying an interactive prompt', async () => {
    const h = hooked()
    h.observe()
    h.rows.push(row({ state: 'working', receivedAt: SENT_AT + 500, interactivePrompt: '{"q":1}' }))
    await advance(1_000)

    expect(h.callbacks.onNeedsYou).toHaveBeenCalledWith('interactive-prompt')
  })

  it('wakes on a status-change notification for its pane without waiting for the poll', async () => {
    const h = hooked()
    const result = h.observe()
    await advance(10)
    h.rows.splice(
      0,
      h.rows.length,
      row({ state: 'waiting', receivedAt: SENT_AT + 40, turnStartedAt: SENT_AT + 15 })
    )
    for (const listener of h.listeners) {
      listener([{ paneKey: 'other:leaf' }])
    }
    await advance(1)
    expect(h.hookSource.getStatusSnapshotForPane).toHaveBeenCalledTimes(1)
    for (const listener of h.listeners) {
      listener([{ paneKey: 'tab-1:leaf-1' }])
    }
    await advance(1)

    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('reports crashed when the pty is verified exited', async () => {
    const h = hooked()
    h.runtime.getPtyLivenessVerdict?.mockReturnValue({ status: 'exited' })
    h.runtime.waitForTerminal.mockResolvedValue(
      wait({ condition: 'exit', status: 'exited', exitCode: 137 })
    )
    const result = h.observe()
    h.rows.push(row({ state: 'working', receivedAt: SENT_AT + 100 }))
    await advance(1_000)

    await expect(result).resolves.toEqual({ kind: 'crashed', exitCode: 137 })
  })

  it('never calls an unreachable host crashed', async () => {
    const h = hooked()
    h.runtime.getPtyLivenessVerdict?.mockImplementation(() => {
      throw new Error('ssh relay disconnected')
    })
    const result = h.observe()
    h.rows.push(row({ state: 'working', receivedAt: SENT_AT + 100 }))
    await advance(1_000)

    await expect(result).resolves.toEqual({ kind: 'unverifiable' })
  })

  it('works when the runtime and hook source omit their optional members', async () => {
    const h = hooked({ withLiveness: false, withSubscribe: false })
    const result = h.observe()
    h.rows.push(row({ state: 'working', receivedAt: SENT_AT + 100 }))
    await advance(1_000)
    h.rows.splice(0, h.rows.length, row({ state: 'waiting', receivedAt: SENT_AT + 1_500 }))
    await advance(1_000)

    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('resolves aborted when the signal fires', async () => {
    const h = hooked()
    const result = h.observe()
    await advance(500)
    h.controller.abort()
    await advance(1)

    await expect(result).resolves.toEqual({ kind: 'aborted' })
  })

  it('unsubscribes from status changes when it settles', async () => {
    const h = hooked()
    const result = h.observe()
    h.rows.push(
      row({ state: 'waiting', receivedAt: SENT_AT + 3_000, turnStartedAt: SENT_AT + 500 })
    )
    await advance(1_000)
    await result

    expect(h.listeners.size).toBe(0)
  })
})

describe('iteration observer without hook rows', () => {
  it('treats an unsatisfied tui-idle poll as the busy edge, then settles on the next satisfied one', async () => {
    const h = harness()
    h.runtime.waitForTerminal
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(wait())
    const result = h.observe()
    await advance(5_000)

    await expect(result).resolves.toMatchObject({ kind: 'settled' })
    expect(h.runtime.waitForTerminal).toHaveBeenCalledWith(
      'term-1',
      expect.objectContaining({ condition: 'tui-idle' })
    )
  })

  it('does not settle on tui-idle satisfied before any busy edge', async () => {
    const h = harness()
    let settled = false
    const result = h.observe().then((value) => {
      settled = true
      return value
    })
    await advance(30_000)

    expect(settled).toBe(false)
    await advance(ITERATION_NO_BUSY_EDGE_SETTLE_MS)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('reports any blockedReason as needs-you and resumes when it clears', async () => {
    const h = harness()
    h.runtime.waitForTerminal
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(wait({ satisfied: false, blockedReason: 'agent-trust-workspace' }))
      .mockResolvedValueOnce(wait({ satisfied: false, blockedReason: 'agent-trust-workspace' }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(wait())
    const result = h.observe()
    await advance(10_000)

    expect(h.callbacks.onNeedsYou).toHaveBeenCalledTimes(1)
    expect(h.callbacks.onNeedsYou).toHaveBeenCalledWith('agent-trust-workspace')
    expect(h.callbacks.onResumed).toHaveBeenCalledTimes(1)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('keeps the no-busy-edge clock stopped while a startup dialog blocks the agent', async () => {
    const h = harness()
    h.runtime.waitForTerminal.mockResolvedValue(
      wait({ satisfied: false, blockedReason: 'agent-trust-workspace' })
    )
    let settled = false
    const result = h.observe().then((value) => {
      settled = true
      return value
    })
    await advance(ITERATION_NO_BUSY_EDGE_SETTLE_MS * 2)
    expect(settled).toBe(false)

    h.runtime.waitForTerminal.mockResolvedValue(wait())
    await advance(ITERATION_NO_BUSY_EDGE_SETTLE_MS - 5_000)
    expect(settled).toBe(false)
    await advance(10_000)
    await expect(result).resolves.toMatchObject({ kind: 'settled' })
  })

  it('reports crashed with the exit code when the terminal exited', async () => {
    const h = harness()
    h.runtime.waitForTerminal.mockResolvedValue(
      wait({ satisfied: true, status: 'exited', exitCode: 1 })
    )
    const result = h.observe()
    await advance(1_000)

    await expect(result).resolves.toEqual({ kind: 'crashed', exitCode: 1 })
  })

  it('reports unverifiable when the wait fails for a reason other than a timeout', async () => {
    const h = harness()
    h.runtime.waitForTerminal.mockRejectedValue(new Error('terminal_handle_stale'))
    const result = h.observe()
    await advance(1_000)

    await expect(result).resolves.toEqual({ kind: 'unverifiable' })
  })
})
