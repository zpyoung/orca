import { useEffect, useLayoutEffect, useState } from 'react'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalPaneController } from '../components/terminal-pane/use-terminal-pane-controller'
import { formatLoopDuration } from './LoopIterationDetail'
import { LoopRail, type LoopRailPlacement } from './LoopRail'
import { selectLoopForPaneKey } from './loops-slice'

const STACK_BELOW_PX = 720
// these insets match the classes on the rail (w-80 / h-72) and the strip (h-8)
const SIDE_RAIL_INSET = '20rem'
const BOTTOM_RAIL_INSET = '18rem'
const STRIP_INSET = '2rem'

const STRIP_BASE =
  'absolute top-0 left-0 flex h-8 items-center gap-2 overflow-hidden border-b border-border bg-background px-3 text-xs whitespace-nowrap text-muted-foreground'
const STRIP_PLACEMENT: Record<LoopRailPlacement, string> = {
  side: 'right-80',
  bottom: 'right-0'
}

/**
 * Status strip above the live agent terminal: iteration, agent, session policy, and how long the
 * current iteration has been running.
 */
export function LoopStatusStrip({
  paneKey,
  placement = 'side'
}: {
  paneKey: string | null
  placement?: LoopRailPlacement
}): React.JSX.Element | null {
  const loop = useAppStore((state) => (paneKey ? selectLoopForPaneKey(state, paneKey) : undefined))
  const startedAt = loop?.currentIteration?.startedAt
  const unverifiableSince = loop?.unverifiableSince
  const frozen = unverifiableSince !== undefined
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined || frozen) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt, frozen])
  if (!loop) {
    return null
  }
  const current = loop.currentIteration
  const parts = [
    current
      ? translate('fork.loops.rail.iteration.current', 'Iteration {{n}}', { n: current.n })
      : translate('fork.loops.rail.iteration.done', '{{n}} iterations done', {
          n: loop.iterationsCompleted
        }),
    ...(frozen ? [translate('fork.loops.rail.state.unverifiable', 'Unverifiable')] : []),
    getAgentLabel(loop.agent),
    loop.config.sessionPolicy === 'fresh'
      ? translate('fork.loops.rail.strip.sessionFresh', 'fresh session')
      : translate('fork.loops.rail.strip.sessionContinued', 'continued session'),
    ...(current ? [formatLoopDuration((unverifiableSince ?? now) - current.startedAt)] : [])
  ]
  return (
    <div
      role="status"
      aria-label={translate('fork.loops.rail.strip.label', 'Loop status')}
      className={cn(STRIP_BASE, STRIP_PLACEMENT[placement])}
    >
      {parts.join(' · ')}
    </div>
  )
}

/**
 * Renders the loop status strip and rail for a terminal tab whose pane is bound to a loop, and
 * carves their room out of the terminal container: the strip above it, the rail beside it at
 * 720px and wider, below it otherwise.
 */
export function useTerminalPaneLoopRail(controller: TerminalPaneController): React.ReactNode {
  const { containerRef, managedPanes, tabId, terminalContentVisible } = controller
  const boundPaneKey = useAppStore((state) => {
    // upstream surface suites mock the store without the loops slice
    if (!('loopIdByPaneKey' in state)) {
      return null
    }
    for (const pane of managedPanes) {
      const paneKey = makePaneKey(tabId, pane.leafId)
      if (selectLoopForPaneKey(state, paneKey)) {
        return paneKey
      }
    }
    return null
  })
  const [placement, setPlacement] = useState<LoopRailPlacement>('side')
  const showRail = boundPaneKey !== null && terminalContentVisible

  useLayoutEffect(() => {
    if (!showRail) {
      return
    }
    const container = containerRef.current
    const host = container?.offsetParent ?? container?.parentElement
    if (!container || !host) {
      return
    }
    container.style.top = STRIP_INSET
    const apply = (): void => {
      const stacked = host.clientWidth < STACK_BELOW_PX
      setPlacement(stacked ? 'bottom' : 'side')
      container.style.right = stacked ? '' : SIDE_RAIL_INSET
      container.style.bottom = stacked ? BOTTOM_RAIL_INSET : ''
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(host)
    return () => {
      observer.disconnect()
      container.style.top = ''
      container.style.right = ''
      container.style.bottom = ''
    }
  }, [containerRef, showRail])

  return showRail ? (
    <>
      <LoopStatusStrip paneKey={boundPaneKey} placement={placement} />
      <LoopRail paneKey={boundPaneKey} placement={placement} />
    </>
  ) : null
}
