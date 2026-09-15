import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { useAppStore } from '../../store'
import { sendRuntimePtyInputVerified } from '../runtime-terminal-inspection'

const localWrite = vi.fn()
const localWriteAccepted = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      pty: {
        write: localWrite,
        writeAccepted: localWriteAccepted
      }
    }
  })
  useAppStore.setState({
    terminalLayoutsByTabId: {},
    lastTerminalInputAtByPaneKey: {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('verified runtime input cancellation', () => {
  it('does not dispatch after cancellation during deferred input measurement', async () => {
    vi.useFakeTimers()
    localWriteAccepted.mockResolvedValue(true)
    let cancelled = false
    const pending = sendRuntimePtyInputVerified(
      { activeRuntimeEnvironmentId: null },
      'local-pty',
      'a'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1),
      () => cancelled
    )
    cancelled = true

    await vi.runAllTimersAsync()

    await expect(pending).resolves.toBe(false)
    expect(localWriteAccepted).not.toHaveBeenCalled()
    expect(localWrite).not.toHaveBeenCalled()
  })

  it('does not resume with a fallback write after cancellation while acceptance is pending', async () => {
    let settleAcceptance: ((accepted: boolean) => void) | undefined
    localWriteAccepted.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settleAcceptance = resolve
        })
    )
    let cancelled = false
    const pending = sendRuntimePtyInputVerified(
      { activeRuntimeEnvironmentId: null },
      'local-pty',
      'stale input',
      () => cancelled
    )
    await vi.waitFor(() =>
      expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', 'stale input')
    )

    cancelled = true
    if (!settleAcceptance) {
      throw new Error('write acceptance resolver was not installed')
    }
    settleAcceptance(false)

    await expect(pending).resolves.toBe(false)
    expect(localWrite).not.toHaveBeenCalled()
  })
})
