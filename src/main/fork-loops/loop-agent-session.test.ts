import { describe, expect, it, vi } from 'vitest'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import {
  awaitAgentReady,
  holdUntilPaneLive,
  LoopUserInputDuringSendError,
  observeUntilSettled,
  relaunchLoopAgent,
  resolvePane,
  sendAgentPrompt
} from './loop-agent-session'
import type { LoopDriverRuntime } from './loop-driver-types'

function readyArgs(runtime: LoopDriverRuntime, ptyId: string | undefined = 'pty-1') {
  const clock = { now: 0 }
  return {
    clock,
    args: {
      runtime,
      handle: 'term-1',
      ...(ptyId ? { ptyId } : {}),
      signal: new AbortController().signal,
      now: () => clock.now,
      pollMs: 1000,
      onBlocked: vi.fn(),
      onUnblocked: vi.fn()
    }
  }
}

function failingWait(message: string, clock?: { now: number }) {
  return vi.fn(async () => {
    if (clock) {
      clock.now += 1000
    }
    throw new Error(message)
  })
}

describe('awaitAgentReady readiness failures', () => {
  it('reports unverifiable, not crashed, when the host is lost and cannot confirm an exit', async () => {
    const verdict: PtyLivenessVerdict = { status: 'unverifiable', reason: 'ssh down' }
    const { args } = readyArgs({
      waitForTerminal: failingWait('connection lost'),
      getPtyLivenessVerdict: () => verdict
    })

    expect(await awaitAgentReady(args)).toBe('unverifiable')
  })

  it('reports crashed when the host positively reports the pty exited', async () => {
    const { args } = readyArgs({
      waitForTerminal: failingWait('connection lost'),
      getPtyLivenessVerdict: () => ({ status: 'exited' })
    })

    expect(await awaitAgentReady(args)).toBe('crashed')
  })

  it('keeps reporting crashed when no liveness verdict is available', async () => {
    const { args } = readyArgs({ waitForTerminal: failingWait('connection lost') })

    expect(await awaitAgentReady(args)).toBe('crashed')
  })

  it('keeps reporting crashed when the pty id is unknown', async () => {
    const { args } = readyArgs(
      {
        waitForTerminal: failingWait('connection lost'),
        getPtyLivenessVerdict: () => ({ status: 'unverifiable', reason: 'ssh down' })
      },
      ''
    )

    expect(await awaitAgentReady(args)).toBe('crashed')
  })

  it('consults liveness once the readiness deadline passes with only timeouts', async () => {
    const clock = { now: 0 }
    const read = vi.fn((): PtyLivenessVerdict => ({
      status: 'unverifiable',
      reason: 'host unreachable'
    }))
    const { args } = readyArgs({
      waitForTerminal: failingWait('timeout', clock),
      getPtyLivenessVerdict: read
    })

    expect(await awaitAgentReady({ ...args, now: () => clock.now })).toBe('unverifiable')
    expect(read).toHaveBeenCalledWith('pty-1')
  })

  it('reports crashed at the deadline when the pty is live but never became ready', async () => {
    const clock = { now: 0 }
    const { args } = readyArgs({
      waitForTerminal: failingWait('timeout', clock),
      getPtyLivenessVerdict: () => ({ status: 'live', ptyIds: ['pty-1'] })
    })

    expect(await awaitAgentReady({ ...args, now: () => clock.now })).toBe('crashed')
  })
})

describe('holdUntilPaneLive', () => {
  it('waits through unverifiable verdicts and returns live', async () => {
    const verdicts: PtyLivenessVerdict[] = [
      { status: 'unverifiable', reason: 'ssh down' },
      { status: 'live', ptyIds: ['pty-1'] }
    ]
    const sleep = vi.fn(async () => undefined)

    const held = await holdUntilPaneLive({
      runtime: { getPtyLivenessVerdict: () => verdicts.shift() ?? null },
      pane: { handle: 'term-1', ptyId: 'pty-1' },
      signal: new AbortController().signal,
      sleep
    })

    expect(held).toBe('live')
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('returns exited on a positive exit and aborted on abort', async () => {
    const pane = { handle: 'term-1', ptyId: 'pty-1' }
    const exited = await holdUntilPaneLive({
      runtime: { getPtyLivenessVerdict: () => ({ status: 'exited' }) },
      pane,
      signal: new AbortController().signal,
      sleep: async () => undefined
    })
    const controller = new AbortController()
    controller.abort()
    const aborted = await holdUntilPaneLive({
      runtime: {},
      pane,
      signal: controller.signal,
      sleep: async () => undefined
    })

    expect(exited).toBe('exited')
    expect(aborted).toBe('aborted')
  })
})

describe('sendAgentPrompt user-input guard', () => {
  const pane = { handle: 'term-1', ptyId: 'pty-1' }

  function sendHarness(userInputSince: (ptyId: string, since: number) => boolean) {
    const noteLoopWrite = vi.fn()
    const writes: string[] = []
    const runtime = {
      sendTerminalAgentPrompt: vi.fn(
        async (
          _handle: string,
          prompt: string,
          options: { beforeWrite?: (ptyId: string) => void | Promise<void> }
        ) => {
          await options.beforeWrite?.('pty-1')
          writes.push(prompt)
          await options.beforeWrite?.('pty-1')
          return {}
        }
      )
    }
    return { noteLoopWrite, writes, runtime, inputAttribution: { noteLoopWrite, userInputSince } }
  }

  it('vetoes the write before any byte when the user typed since the idle check', async () => {
    const h = sendHarness(() => true)

    await expect(
      sendAgentPrompt(h.runtime, h.inputAttribution, pane, 'go', () => 7, 5)
    ).rejects.toBeInstanceOf(LoopUserInputDuringSendError)

    expect(h.writes).toEqual([])
    expect(h.noteLoopWrite).not.toHaveBeenCalled()
  })

  it('writes and notes the window when the user has been silent since the idle check', async () => {
    const since = vi.fn(() => false)
    const h = sendHarness(since)

    await sendAgentPrompt(h.runtime, h.inputAttribution, pane, 'go', () => 7, 5)

    expect(since).toHaveBeenCalledWith('pty-1', 5)
    expect(h.writes).toEqual(['go'])
    expect(h.noteLoopWrite).toHaveBeenCalledWith('pty-1', 7)
  })

  it('does not veto the second beforeWrite once the paste is written', async () => {
    const answers = [false, true]
    const h = sendHarness(() => answers.shift() ?? true)

    await sendAgentPrompt(h.runtime, h.inputAttribution, pane, 'go', () => 7, 5)

    expect(h.writes).toEqual(['go'])
    expect(answers).toEqual([true])
  })
})

describe('observeUntilSettled hold callbacks', () => {
  it('brackets an unreachable host with hold start and end and then keeps observing', async () => {
    const events: string[] = []
    const observeIteration = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unverifiable' })
      .mockResolvedValueOnce({ kind: 'settled', settledAt: 1 })

    const settlement = await observeUntilSettled({
      runtime: { getPtyLivenessVerdict: () => ({ status: 'live', ptyIds: ['pty-1'] }) },
      observer: { observeIteration },
      pane: { handle: 'term-1', ptyId: 'pty-1' },
      paneKey: () => 'pane',
      sentAt: 0,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      onNeedsYou: vi.fn(),
      onResumed: vi.fn(),
      onPhase: (phase) => events.push(`phase:${phase}`),
      onHoldStart: () => events.push('hold-start'),
      onHoldEnd: () => events.push('hold-end')
    })

    expect(settlement.kind).toBe('settled')
    expect(events).toEqual(['hold-start', 'hold-end', 'phase:working'])
  })

  it('ends the hold even when the pane is found exited', async () => {
    const events: string[] = []

    const settlement = await observeUntilSettled({
      runtime: { getPtyLivenessVerdict: () => ({ status: 'exited' }) },
      observer: { observeIteration: vi.fn().mockResolvedValue({ kind: 'unverifiable' }) },
      pane: { handle: 'term-1', ptyId: 'pty-1' },
      paneKey: () => 'pane',
      sentAt: 0,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      onNeedsYou: vi.fn(),
      onResumed: vi.fn(),
      onPhase: vi.fn(),
      onHoldStart: () => events.push('hold-start'),
      onHoldEnd: () => events.push('hold-end')
    })

    expect(settlement.kind).toBe('crashed')
    expect(events).toEqual(['hold-start', 'hold-end'])
  })
})

/** A runtime shaped like the real one: the handle-to-pty lookup answers only for headless ptys. */
function rendererTabRuntime(panes: Record<string, { ptyId: string; connected: boolean }>) {
  const handleFor = (paneKey: string): string | null => (panes[paneKey] ? `term:${paneKey}` : null)
  return {
    getTerminalHandleForPaneKey: handleFor,
    getTerminalPtyIdForHandle: () => null,
    resolveTerminalPane: (paneKey: string) => {
      const pane = panes[paneKey]
      const handle = handleFor(paneKey)
      if (!pane || !handle) {
        throw new Error('terminal_not_found')
      }
      const [tabId = '', leafId = ''] = paneKey.split(':')
      return { handle, tabId, leafId, ptyId: pane.ptyId, connected: pane.connected }
    },
    launchAgentTerminal: vi.fn(async () => ({
      handle: 'term:tab-2:leaf-2',
      tabId: 'tab-2',
      paneKey: 'tab-2:leaf-2',
      ptyId: 'pty-2',
      worktreeId: 'wt-1',
      title: 'Fix tests'
    })),
    closeTerminalTab: vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab-1',
      closeMode: 'tab' as const,
      ptyKilled: true
    }))
  } satisfies LoopDriverRuntime
}

const RELAUNCH_LOOP = {
  worktreeId: 'wt-1',
  detached: false,
  agent: 'claude' as const,
  name: 'Fix tests',
  launchOverrides: null,
  paneKey: 'tab-1:leaf-1'
}

describe('resolvePane on renderer tabs', () => {
  it('finds a live renderer tab pane the handle lookup cannot answer for', () => {
    const runtime = rendererTabRuntime({ 'tab-1:leaf-1': { ptyId: 'pty-1', connected: true } })

    expect(resolvePane(runtime, 'tab-1:leaf-1')).toEqual({
      handle: 'term:tab-1:leaf-1',
      ptyId: 'pty-1'
    })
  })

  it('treats a pane whose process ended, or that is gone, as no pane', () => {
    const runtime = rendererTabRuntime({ 'tab-1:leaf-1': { ptyId: 'pty-1', connected: false } })

    expect(resolvePane(runtime, 'tab-1:leaf-1')).toBeNull()
    expect(resolvePane(runtime, 'tab-9:leaf-9')).toBeNull()
  })
})

describe('relaunchLoopAgent tab cleanup', () => {
  it('closes the previous live tab after the new one launches', async () => {
    const runtime = rendererTabRuntime({ 'tab-1:leaf-1': { ptyId: 'pty-1', connected: true } })
    const previous = resolvePane(runtime, 'tab-1:leaf-1')

    const launched = await relaunchLoopAgent(runtime, RELAUNCH_LOOP, previous)

    expect(launched.paneKey).toBe('tab-2:leaf-2')
    expect(runtime.closeTerminalTab).toHaveBeenCalledWith('term:tab-1:leaf-1')
  })

  it('closes the tab of the last pane when its agent already exited', async () => {
    const runtime = rendererTabRuntime({ 'tab-1:leaf-1': { ptyId: 'pty-1', connected: false } })

    await relaunchLoopAgent(runtime, RELAUNCH_LOOP, resolvePane(runtime, 'tab-1:leaf-1'))

    expect(runtime.closeTerminalTab).toHaveBeenCalledWith('term:tab-1:leaf-1')
  })

  it('closes nothing when the last tab is already gone', async () => {
    const runtime = rendererTabRuntime({})

    await relaunchLoopAgent(runtime, RELAUNCH_LOOP, null)

    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
  })
})
