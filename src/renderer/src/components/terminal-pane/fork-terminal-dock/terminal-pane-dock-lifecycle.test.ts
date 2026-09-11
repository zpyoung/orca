import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  REMOTE_CONPTY_UNVERIFIED_DATASET_KEY,
  terminalPaneUsesConptyBelowWrapMarkers
} from '../fork-terminal-dock/TerminalPaneDockMount'
import {
  resolveRemoteDockConptyUnverified,
  restampRemoteDockConptyUnverifiedForLivePanes
} from './terminal-dock-remote-conpty'
import { collectTerminalDockPaneKeysForTabTeardown } from './terminal-pane-dock-prune'

type DockConptyState = Pick<AppState, 'sshConnectionStates' | 'runtimeStatusByEnvironmentId'>

function dockConptyState(overrides: Partial<DockConptyState> = {}): DockConptyState {
  return {
    sshConnectionStates: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    ...overrides
  }
}

describe('collectTerminalDockPaneKeysForTabTeardown', () => {
  const paneLeafIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  ]

  it('collects every pane key for a genuinely closed tab', () => {
    expect(
      collectTerminalDockPaneKeysForTabTeardown({
        tabId: 'tab-1',
        tabStillExists: false,
        experimentalTerminalDockEnabled: true,
        paneLeafIds
      })
    ).toEqual([`tab-1:${paneLeafIds[0]}`, `tab-1:${paneLeafIds[1]}`])
  })

  it('returns nothing when the tab still exists elsewhere (rehome/remount)', () => {
    expect(
      collectTerminalDockPaneKeysForTabTeardown({
        tabId: 'tab-1',
        tabStillExists: true,
        experimentalTerminalDockEnabled: true,
        paneLeafIds
      })
    ).toEqual([])
  })

  it('returns nothing when the experimental dock flag is off', () => {
    expect(
      collectTerminalDockPaneKeysForTabTeardown({
        tabId: 'tab-1',
        tabStillExists: false,
        experimentalTerminalDockEnabled: false,
        paneLeafIds
      })
    ).toEqual([])
  })
})

describe('resolveRemoteDockConptyUnverified', () => {
  it('returns null for a local execution host — the local windowsPty option already covers it', () => {
    expect(
      resolveRemoteDockConptyUnverified({ executionHostId: 'local', state: dockConptyState() })
    ).toBeNull()
  })

  it('demotes an SSH host whose remote platform has not been reported yet', () => {
    expect(
      resolveRemoteDockConptyUnverified({
        executionHostId: 'ssh:my-host',
        state: dockConptyState()
      })
    ).toBe(true)
  })

  it('demotes an SSH host confirmed to be Windows', () => {
    expect(
      resolveRemoteDockConptyUnverified({
        executionHostId: 'ssh:my-host',
        state: dockConptyState({
          sshConnectionStates: new Map([
            [
              'my-host',
              {
                targetId: 'my-host',
                status: 'connected',
                error: null,
                reconnectAttempt: 0,
                remotePlatform: 'win32'
              }
            ]
          ])
        })
      })
    ).toBe(true)
  })

  it('keeps an SSH host confirmed non-Windows verified-eligible', () => {
    expect(
      resolveRemoteDockConptyUnverified({
        executionHostId: 'ssh:my-host',
        state: dockConptyState({
          sshConnectionStates: new Map([
            [
              'my-host',
              {
                targetId: 'my-host',
                status: 'connected',
                error: null,
                reconnectAttempt: 0,
                remotePlatform: 'linux'
              }
            ]
          ])
        })
      })
    ).toBe(false)
  })

  it('demotes a runtime host whose host platform is unknown', () => {
    expect(
      resolveRemoteDockConptyUnverified({
        executionHostId: 'runtime:my-env',
        state: dockConptyState()
      })
    ).toBe(true)
  })

  it('keeps a runtime host confirmed non-Windows verified-eligible', () => {
    expect(
      resolveRemoteDockConptyUnverified({
        executionHostId: 'runtime:my-env',
        state: dockConptyState({
          runtimeStatusByEnvironmentId: new Map([
            ['my-env', { status: { hostPlatform: 'darwin' }, checkedAt: 0 } as never]
          ])
        })
      })
    ).toBe(false)
  })
})

describe('restampRemoteDockConptyUnverifiedForLivePanes', () => {
  function makeStampablePane(initialStamp?: 'true' | 'false'): {
    container: { dataset: Record<string, string> }
  } {
    const dataset: Record<string, string> = {}
    if (initialStamp !== undefined) {
      dataset[REMOTE_CONPTY_UNVERIFIED_DATASET_KEY] = initialStamp
    }
    return { container: { dataset } }
  }

  it('leaves local panes untouched — a null verdict is a no-op', () => {
    const getPanes = vi.fn(() => [makeStampablePane()])
    const changed = restampRemoteDockConptyUnverifiedForLivePanes({ getPanes }, null)
    expect(changed).toBe(false)
    expect(getPanes).not.toHaveBeenCalled()
  })

  it('upgrades a pane stamped unknown once the host platform hydrates to Linux, and the consumer observes it', () => {
    const pane = makeStampablePane('true')

    const changed = restampRemoteDockConptyUnverifiedForLivePanes({ getPanes: () => [pane] }, false)

    expect(changed).toBe(true)
    expect(
      terminalPaneUsesConptyBelowWrapMarkers({
        container: pane.container,
        terminal: { options: {} }
      } as never)
    ).toBe(false)
  })

  it('keeps a pane demoted when hydration confirms an old/unknown Windows host', () => {
    const pane = makeStampablePane('true')

    const changed = restampRemoteDockConptyUnverifiedForLivePanes({ getPanes: () => [pane] }, true)

    expect(changed).toBe(false)
    expect(
      terminalPaneUsesConptyBelowWrapMarkers({
        container: pane.container,
        terminal: { options: {} }
      } as never)
    ).toBe(true)
  })
})
