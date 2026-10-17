import { toast } from 'sonner'
import { shouldConfirmRunningTerminalClose } from '@/components/terminal/running-terminal-close-guard'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { TerminalTabCloseReason } from '@/store/slices/terminal-tab-retirement'
import type { LoopSnapshot } from '../../../shared/fork-loops/loop-types'

export type LoopCloseChoice = 'keep-running' | 'stop'

type LoopCloseOptions = {
  force?: boolean
  rejectPinned?: boolean
  reason?: TerminalTabCloseReason
  hostCloseReason?: TerminalTabCloseReason
  lifecyclePtyId?: string
  skipRunningProcessConfirm?: boolean
  onCancel?: () => void
}

let pendingCancel: (() => void) | undefined

function findLiveLoopForTab(terminalTabId: string): LoopSnapshot | undefined {
  const loopsById = useAppStore.getState().loopsById ?? {}
  return Object.values(loopsById).find(
    (loop) =>
      loop.tab?.tabId === terminalTabId && (loop.state === 'running' || loop.state === 'needs-you')
  )
}

/**
 * Takes over the close of a tab hosting a running or needs-you loop and asks whether to keep the
 * loop running in the background or stop it. Returns `true` when it took over; `reenter` runs after
 * the user's choice has been applied. Returns `false` without prompting for closes that must never
 * raise a modal (agent exit, lifecycle and bulk closes, and the post-confirmation re-entry).
 */
export function guardLoopTerminalClose(
  terminalTabId: string,
  options: LoopCloseOptions | undefined,
  reenter: () => void
): boolean {
  const loop = findLiveLoopForTab(terminalTabId)
  if (!loop || !shouldConfirmRunningTerminalClose(options)) {
    return false
  }
  pendingCancel = options?.onCancel
  useAppStore.getState().requestLoopCloseConfirm({
    loopId: loop.id,
    tabId: terminalTabId,
    onDone: reenter
  })
  return true
}

/** Applies the user's choice to the pending loop close, then lets the close proceed. */
export async function resolveLoopCloseChoice(choice: LoopCloseChoice): Promise<void> {
  const pending = useAppStore.getState().loopCloseConfirm
  if (!pending) {
    return
  }
  try {
    const api = window.api.loops
    await (choice === 'keep-running' ? api.detach(pending.loopId) : api.stop(pending.loopId, 'now'))
  } catch (error) {
    // closing anyway would end the agent PTY with the loop still marked running
    toast.error(
      translate(
        'fork.loops.status.close.failed',
        'Could not update the loop, so the tab stays open.'
      ),
      { description: error instanceof Error ? error.message : undefined }
    )
    cancelLoopClose()
    return
  }
  pendingCancel = undefined
  useAppStore.getState().resolveLoopCloseConfirm()
}

/** Abandons the pending loop close and reports it to the original caller. */
export function cancelLoopClose(): void {
  const onCancel = pendingCancel
  pendingCancel = undefined
  useAppStore.setState({ loopCloseConfirm: null })
  onCancel?.()
}
