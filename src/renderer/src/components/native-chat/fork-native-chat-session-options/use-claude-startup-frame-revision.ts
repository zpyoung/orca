import { useEffect, useState } from 'react'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import { subscribeToPtyData } from '../../terminal-pane/pty-data-sidecar-subscriptions'
import type { NativeChatPtySessionOptionsSurface } from '../native-chat-pty-session-options'

const FRAME_SETTLE_MS = 100
const FRAME_RETRY_MS = 500
const FRAME_GIVE_UP_MS = 10_000

function hasResolvedModel(surface: NativeChatPtySessionOptionsSurface): boolean {
  const model = surface.getSnapshot().find((descriptor) => descriptor.id === 'model')
  return model?.kind.type === 'select' && typeof model.kind.currentValue === 'string'
}

/** Whether local PTY state outranks an untimestamped startup-frame scrape. */
export function hasDispatchedNativeChatSessionOption(
  surface: NativeChatPtySessionOptionsSurface
): boolean {
  return surface.getSnapshot().some((descriptor) => descriptor.valueSource === 'dispatched')
}

/**
 * Re-runs Claude's startup-frame scrape as its startup PTY output settles.
 * Stops once the model is known or the startup window expires.
 */
export function useClaudeStartupFrameRevision(args: {
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  surface: NativeChatPtySessionOptionsSurface | null
}): number {
  const { agent, surface, targetPtyId, terminalTabId } = args
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (agent !== 'claude' || !surface || !targetPtyId || hasResolvedModel(surface)) {
      return
    }

    let stopped = false
    let revisionTimer: number | null = null
    let giveUpTimer: number | null = null
    let unsubscribeData: (() => void) | null = null
    let unsubscribeSurface: (() => void) | null = null

    const stop = (): void => {
      if (stopped) {
        return
      }
      stopped = true
      if (revisionTimer !== null) {
        window.clearTimeout(revisionTimer)
        revisionTimer = null
      }
      if (giveUpTimer !== null) {
        window.clearTimeout(giveUpTimer)
        giveUpTimer = null
      }
      unsubscribeData?.()
      unsubscribeData = null
      unsubscribeSurface?.()
      unsubscribeSurface = null
    }

    const scheduleRevision = (delayMs: number): void => {
      if (stopped || revisionTimer !== null) {
        return
      }
      revisionTimer = window.setTimeout(() => {
        revisionTimer = null
        if (stopped) {
          return
        }
        setRevision((value) => value + 1)
        // xterm can apply a synchronized frame after the raw PTY burst has ended.
        scheduleRevision(FRAME_RETRY_MS)
      }, delayMs)
    }

    const observeData = (): void => scheduleRevision(FRAME_SETTLE_MS)

    unsubscribeSurface = surface.subscribe(() => {
      if (hasResolvedModel(surface)) {
        stop()
      }
    })
    giveUpTimer = window.setTimeout(stop, FRAME_GIVE_UP_MS)

    try {
      if (isRemoteRuntimePtyId(targetPtyId)) {
        void subscribeToRuntimeTerminalData(
          getSettingsForAgentTabRuntimeOwner(terminalTabId),
          targetPtyId,
          `desktop:native-chat-startup-frame:${targetPtyId}`,
          observeData
        )
          .then((dispose) => {
            if (stopped) {
              dispose()
            } else {
              unsubscribeData = dispose
            }
          })
          .catch(stop)
      } else {
        unsubscribeData = subscribeToPtyData(targetPtyId, observeData)
      }
    } catch {
      stop()
    }

    return stop
  }, [agent, surface, targetPtyId, terminalTabId])

  return revision
}
