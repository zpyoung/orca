import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, subscriptionSendBinary, latestSubscribePayload, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

const TAB_ID = 'web-terminal-host-tab-1'

type PtyRebindSpy = Mock<
  (ptyId: string, replacedPtyId: string, incarnationId?: string | null) => void
>

type RecoveredPane = {
  /** Arm/release events for TAB_ID, recorded from before recovery was triggered. */
  quarantineEvents: boolean[]
  dispose: () => void
}

beforeEach(() => {
  resetRemoteRuntimeTransport()
})

/**
 * `terminal.recoverPane` always spawns a shell, but neither the handle nor the incarnation stamp
 * proves it: a legacy host answers with the handle it was given and no stamp at all. The transport
 * is the only layer that knows the call it made, so it arms the tab's input quarantine itself
 * instead of leaving the pane bind to infer replacement from an identity change.
 */
describe('remote fresh-shell recovery quarantine', () => {
  async function recoverExpiredPaneAs(
    recoveredHandle: string,
    onPtyRebind: PtyRebindSpy
  ): Promise<RecoveredPane> {
    resolvedPaneHandle = 'terminal-expired'
    // The harness resets the module registry, so both modules must be loaded from this generation
    // or the spec would watch a quarantine map the transport never writes to.
    const { createRemoteRuntimePtyTransport } = await import('../remote-runtime-pty-transport')
    const { subscribeTerminalInputQuarantine, _resetTerminalInputQuarantineForTests } =
      await import('../terminal-input-quarantine')
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: TAB_ID,
      leafId: 'pane:1',
      onPtyRebind
    })
    transport.attach({ existingPtyId: 'remote:hub-env@@terminal-expired', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.recoverPane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: recoveredHandle,
              tabId: 'host-tab-1',
              leafId: 'pane:1',
              ptyId: 'ssh-private-pty',
              worktreeId: 'wt-1'
            }
          }
        }
      }
      return { ok: true, result: {} }
    })

    const callbacks = subscriptionCallbacks
    if (!callbacks) {
      throw new Error('transport subscription callbacks were not installed')
    }
    // Subscribing beats reading the map afterwards: quarantine self-releases on a real 5s timer,
    // so a slow run would observe an armed tab as unarmed.
    const quarantineEvents: boolean[] = []
    const unsubscribe = subscribeTerminalInputQuarantine(TAB_ID, (armed) => {
      quarantineEvents.push(armed)
    })
    callbacks.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'SSH_SESSION_EXPIRED: relay identity changed'
      }
    })

    return {
      quarantineEvents,
      dispose: () => {
        unsubscribe()
        transport.disconnect()
        _resetTerminalInputQuarantineForTests()
      }
    }
  }

  it('quarantines the tab when recovery reuses an unstamped provider handle', async () => {
    const onPtyRebind: PtyRebindSpy = vi.fn()
    const recovery = await recoverExpiredPaneAs('terminal-expired', onPtyRebind)
    try {
      await vi.waitFor(() => expect(recovery.quarantineEvents).toContain(true))
      // Identity did not move, so the pane has nothing to rebind — the quarantine is the whole fix.
      expect(onPtyRebind).not.toHaveBeenCalled()
    } finally {
      recovery.dispose()
    }
  })

  it('quarantines the tab alongside the identity rebind when the handle is replaced', async () => {
    const onPtyRebind: PtyRebindSpy = vi.fn()
    const recovery = await recoverExpiredPaneAs('terminal-replacement', onPtyRebind)
    try {
      await vi.waitFor(() => expect(onPtyRebind).toHaveBeenCalled())
      expect(recovery.quarantineEvents).toContain(true)
      expect(onPtyRebind).toHaveBeenCalledWith(
        'remote:hub-env@@terminal-replacement',
        'remote:hub-env@@terminal-expired'
      )
    } finally {
      recovery.dispose()
    }
  })
})
