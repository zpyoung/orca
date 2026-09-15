import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine,
  isTerminalInputQuarantined,
  shouldDropQuarantinedTerminalInput
} from '../terminal-input-quarantine'
import { installPanePtyVisibilityBind } from '../pty-connection/pane-pty-visibility-bind'
import type { ConnectPanePtySession } from '../pty-connection/connect-pane-pty-session'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
  }
}))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

const TAB_ID = 'tab-1'
const OLD_PTY_ID = 'remote:env-1@@terminal-old'
const NEW_PTY_ID = 'remote:env-1@@terminal-new'

function buildSession(initialIncarnationId: string | null): ConnectPanePtySession {
  const transport = {
    getPtyId: () => OLD_PTY_ID,
    disconnect: vi.fn()
  }
  const session = {
    pane: { id: 'pane-1', leafId: 'leaf-1' },
    deps: {
      tabId: TAB_ID,
      paneTransportsRef: { current: new Map([['pane-1', transport]]) }
    },
    transport,
    disposed: false,
    remotePtyIncarnationId: initialIncarnationId,
    canAdoptCapturedDirectSshRetryPty: () => true,
    claimCapturedDirectSshRetryPty: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer owns the omitted mutable session methods and these tests replace the one callback dependency they exercise.
  const installedSession = session as unknown as ConnectPanePtySession
  installPanePtyVisibilityBind(installedSession)
  return installedSession
}

beforeEach(() => {
  _resetTerminalInputQuarantineForTests()
})
afterEach(() => {
  _resetTerminalInputQuarantineForTests()
})

describe('remote PTY rebind input quarantine', () => {
  it('arms before binding a replacement shell and drops its stale input tail', () => {
    const session = buildSession('shell-incarnation-1')
    let quarantinedWhenBound = false
    session.bindActivePanePty = vi.fn(() => {
      quarantinedWhenBound = isTerminalInputQuarantined(TAB_ID)
      return true
    })

    session.onPtyRebind(NEW_PTY_ID, OLD_PTY_ID, 'shell-incarnation-2')

    expect(quarantinedWhenBound).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB_ID, 'cho hi; rm -rf x\r')).toBe(true)
  })

  it('preserves input when only the provider handle changes for the same shell', () => {
    const session = buildSession('shell-incarnation-1')
    session.bindActivePanePty = vi.fn(() => true)

    session.onPtyRebind(NEW_PTY_ID, OLD_PTY_ID, 'shell-incarnation-1')

    expect(isTerminalInputQuarantined(TAB_ID)).toBe(false)
    expect(shouldDropQuarantinedTerminalInput(TAB_ID, 'echo safe\r')).toBe(false)
  })

  it('leaves ordinary initial PTY binding unquarantined', () => {
    const session = buildSession(null)
    session.bindActivePanePty = vi.fn(() => true)

    session.onPtySpawn(NEW_PTY_ID)

    expect(isTerminalInputQuarantined(TAB_ID)).toBe(false)
    expect(shouldDropQuarantinedTerminalInput(TAB_ID, 'echo safe\r')).toBe(false)
  })

  it.each([
    ['previous', null, 'shell-incarnation-2'],
    ['next', 'shell-incarnation-1', null],
    ['both', null, null]
  ] as const)(
    'preserves input on an ordinary handle rotation when the %s shell incarnation is unknown',
    (_label, previous, next) => {
      const session = buildSession(previous)
      session.bindActivePanePty = vi.fn(() => true)

      session.onPtyRebind(NEW_PTY_ID, OLD_PTY_ID, next)

      expect(isTerminalInputQuarantined(TAB_ID)).toBe(false)
      expect(shouldDropQuarantinedTerminalInput(TAB_ID, 'echo safe\r')).toBe(false)
    }
  )

  it.each([
    ['previous', null, 'shell-incarnation-2'],
    ['next', 'shell-incarnation-1', null],
    ['both', null, null]
  ] as const)(
    'keeps a caller-armed quarantine while binding a replacement whose %s incarnation is unknown',
    (_label, previous, next) => {
      const session = buildSession(previous)
      let quarantinedWhenBound = false
      session.bindActivePanePty = vi.fn(() => {
        quarantinedWhenBound = isTerminalInputQuarantined(TAB_ID)
        return true
      })
      // The remote transport arms this before it rebinds, because only it knows a recoverPane call
      // spawned a shell; binding must carry that decision through rather than re-derive it.
      armTerminalInputQuarantine(TAB_ID)

      session.onPtyRebind(NEW_PTY_ID, OLD_PTY_ID, next)

      expect(quarantinedWhenBound).toBe(true)
      expect(shouldDropQuarantinedTerminalInput(TAB_ID, 'cho hi; rm -rf x\r')).toBe(true)
    }
  )
})
