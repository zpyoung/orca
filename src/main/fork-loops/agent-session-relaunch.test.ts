import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-contracts'
import { LoopRuntimeUnavailableError, relaunchAgentInNewTab } from './agent-session-relaunch'

function created(overrides: Partial<RuntimeTerminalCreate> = {}): RuntimeTerminalCreate {
  return {
    handle: 'term-new',
    tabId: 'tab-new',
    paneKey: 'tab-new:leaf-new',
    ptyId: 'pty-new',
    worktreeId: 'wt-1',
    title: 'Loop',
    ...overrides
  }
}

function runtimeDouble() {
  const calls: string[] = []
  const launchAgentTerminal = vi.fn(async (): Promise<RuntimeTerminalCreate> => {
    calls.push('launch')
    return created()
  })
  const closeTerminalTab = vi.fn(async (handle: string) => {
    calls.push(`close:${handle}`)
    return { handle, tabId: 'tab-old', closeMode: 'tab' as const, ptyKilled: false }
  })
  return { calls, launchAgentTerminal, closeTerminalTab }
}

const baseArgs = {
  worktreeId: 'wt-1',
  previousHandle: 'term-old' as string | null,
  agent: 'claude' as const,
  title: 'Loop'
}

describe('relaunchAgentInNewTab', () => {
  it('launches the new tab before closing the previous one', async () => {
    const runtime = runtimeDouble()

    await relaunchAgentInNewTab(runtime, baseArgs)

    expect(runtime.calls).toEqual(['launch', 'close:term-old'])
  })

  it('launches with an empty prompt, the title and the overrides', async () => {
    const runtime = runtimeDouble()
    const launchOverrides = { model: 'opus' }

    await relaunchAgentInNewTab(runtime, { ...baseArgs, launchOverrides })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'claude',
      prompt: '',
      title: 'Loop',
      launchOverrides
    })
  })

  it('omits launchOverrides when none are given', async () => {
    const runtime = runtimeDouble()

    await relaunchAgentInNewTab(runtime, baseArgs)

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'claude',
      prompt: '',
      title: 'Loop'
    })
  })

  it('returns the identity of the new launch', async () => {
    const runtime = runtimeDouble()

    await expect(relaunchAgentInNewTab(runtime, baseArgs)).resolves.toEqual({
      handle: 'term-new',
      tabId: 'tab-new',
      paneKey: 'tab-new:leaf-new',
      ptyId: 'pty-new'
    })
  })

  it('skips the close when there is no previous handle', async () => {
    const runtime = runtimeDouble()

    await relaunchAgentInNewTab(runtime, { ...baseArgs, previousHandle: null })

    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('treats a previous handle that is already gone as closed', async () => {
    const runtime = runtimeDouble()
    runtime.closeTerminalTab.mockRejectedValue(new Error('terminal_handle_stale'))

    await expect(relaunchAgentInNewTab(runtime, baseArgs)).resolves.toMatchObject({
      handle: 'term-new'
    })
  })

  it('surfaces a close failure that is not a gone handle', async () => {
    const runtime = runtimeDouble()
    runtime.closeTerminalTab.mockRejectedValue(new Error('workspace_session_unavailable'))

    await expect(relaunchAgentInNewTab(runtime, baseArgs)).rejects.toThrow(
      'workspace_session_unavailable'
    )
  })

  it('rejects on a launch failure and leaves the previous tab open', async () => {
    const runtime = runtimeDouble()
    runtime.launchAgentTerminal.mockRejectedValue(new Error('agent disabled'))

    await expect(relaunchAgentInNewTab(runtime, baseArgs)).rejects.toThrow('agent disabled')
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('rejects with loop_runtime_unavailable when the runtime cannot launch', async () => {
    const runtime = { closeTerminalTab: vi.fn() }

    const failure = await relaunchAgentInNewTab(runtime, baseArgs).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LoopRuntimeUnavailableError)
    expect(failure).toMatchObject({ code: 'loop_runtime_unavailable' })
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('rejects and closes the new tab when the launch reports no tab identity', async () => {
    const runtime = runtimeDouble()
    runtime.launchAgentTerminal.mockResolvedValue(created({ paneKey: null }))

    await expect(relaunchAgentInNewTab(runtime, baseArgs)).rejects.toThrow()
    expect(runtime.closeTerminalTab).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminalTab).toHaveBeenCalledWith('term-new')
  })

  it('closes nothing when the runtime lacks closeTerminalTab', async () => {
    const launchAgentTerminal = vi.fn(async () => created())

    await expect(relaunchAgentInNewTab({ launchAgentTerminal }, baseArgs)).resolves.toMatchObject({
      handle: 'term-new'
    })
  })
})
