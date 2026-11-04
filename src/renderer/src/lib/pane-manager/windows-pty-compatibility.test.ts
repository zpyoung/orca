import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  buildWindowsPtyCompatibilityOptions,
  isLocalNativeWindowsConpty,
  isLocalNativeWindowsPty,
  isRemoteWindowsConptyStatusUnverified,
  resolveWindowsShellOverride
} from './windows-pty-compatibility'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('buildWindowsPtyCompatibilityOptions', () => {
  it('does not mark the row after a full-width Windows status line as wrapped', async () => {
    const options = buildWindowsPtyCompatibilityOptions({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      osRelease: '10.0.19045',
      connectionId: null,
      cwd: 'C:\\repo',
      shellOverride: null,
      executionHostId: 'local'
    })
    const terminal = new Terminal({ cols: 20, rows: 5, ...options })

    await writeTerminal(terminal, `${'─'.repeat(20)}\r\nNEXT\r\n`)

    // Old Windows wrapping falsely joins full-width rows, breaking reported Chinese scrollback.
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('NEXT')
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false)
  })
})

describe('isRemoteWindowsConptyStatusUnverified', () => {
  it('demotes when the remote platform has not been reported yet', () => {
    expect(isRemoteWindowsConptyStatusUnverified(undefined)).toBe(true)
    expect(isRemoteWindowsConptyStatusUnverified(null)).toBe(true)
  })

  it('demotes a remote host confirmed to be Windows — no remote ConPTY build number is ever known', () => {
    expect(isRemoteWindowsConptyStatusUnverified('win32')).toBe(true)
  })

  it('stays verified-eligible for a remote host confirmed non-Windows', () => {
    expect(isRemoteWindowsConptyStatusUnverified('linux')).toBe(false)
    expect(isRemoteWindowsConptyStatusUnverified('darwin')).toBe(false)
  })
})
