import { LOOPS_CHANGED_CHANNEL } from '../../shared/fork-loops/api'
import type { LoopSnapshot } from '../../shared/fork-loops/loop-types'
import { sendToTrustedUIRenderer } from '../ipc/ui'

type LoopChangeSource = { onChange(listener: (snapshot: LoopSnapshot) => void): () => void }

/** Pushes every loop snapshot to the main window on `loops:changed`. */
export function forwardLoopChangesToRenderer(
  service: LoopChangeSource,
  send: (channel: string, payload: unknown) => void = sendToTrustedUIRenderer
): () => void {
  return service.onChange((snapshot) => send(LOOPS_CHANGED_CHANNEL, snapshot))
}
