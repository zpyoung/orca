import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { TerminalDock } from '../terminal-dock/TerminalDock'
import { applyTerminalDockGeometryChange } from './terminal-pane-dock-geometry'
import { beginTerminalDockGutterDrag } from './terminal-pane-dock-gutter-drag'

/** ManagedPane's public view drops the internal dockContainer field (pane-public-view.ts), so
 *  reach it the same way the pane DOM itself advertises it: the '.pane-dock-slot' class every
 *  pane's container carries (pane-dom-creation.ts). */
function findDockContainer(pane: ManagedPane): HTMLElement | null {
  return pane.container.querySelector<HTMLElement>('.pane-dock-slot')
}

export type TerminalPaneDockMountProps = {
  pane: ManagedPane
  terminalTabId: string
  paneKey: string
  agent: AgentType
  docked: boolean
  gutterRows: number
  targetPtyId: string | null
  disabledReason: string | null
  readTerminalScreen: () => string | null
  onCommitGutterRows: (rows: number) => void
  passthroughActive: boolean
}

/** Portals the dock into the pane's reserved DOM slot and owns the single point where its
 *  DOM geometry changes (mount/unmount edges, live drag) get coalesced into exactly one PTY
 *  resize. Renders nothing when not docked — the caller already gates the experimental flag
 *  and agent eligibility, so reaching here at all means the feature is live for this pane. */
export function TerminalPaneDockMount(props: TerminalPaneDockMountProps): React.JSX.Element | null {
  const { pane } = props
  const [liveGutterRows, setLiveGutterRows] = useState<number | null>(null)
  // Why: the auto-undock hysteresis needs the pane's own available height, not the
  // terminal's — the split layout fixes this pane's box; only the internal xterm/dock
  // split moves, so this never feeds back into itself when the dock mounts or resizes.
  const [paneHeightPx, setPaneHeightPx] = useState(
    () => pane.container.getBoundingClientRect().height
  )

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return undefined
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setPaneHeightPx(entry.contentRect.height)
      }
    })
    observer.observe(pane.container)
    return () => observer.disconnect()
  }, [pane])

  const handleMountedChange = useCallback(() => {
    applyTerminalDockGeometryChange(pane)
  }, [pane])

  const { gutterRows, onCommitGutterRows } = props
  const handleGutterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      beginTerminalDockGutterDrag(event, {
        pane,
        startGutterRows: gutterRows,
        onLiveRowsChange: setLiveGutterRows,
        onCommit: (rows) => {
          setLiveGutterRows(null)
          onCommitGutterRows(rows)
        }
      })
    },
    [gutterRows, onCommitGutterRows, pane]
  )

  const dockContainer = useMemo(() => findDockContainer(pane), [pane])

  if (!props.docked || !dockContainer) {
    return null
  }

  return createPortal(
    <TerminalDock
      terminalTabId={props.terminalTabId}
      paneKey={props.paneKey}
      targetPtyId={props.targetPtyId}
      agent={props.agent}
      paneHeightPx={paneHeightPx}
      gutterRows={liveGutterRows ?? props.gutterRows}
      disabledReason={props.disabledReason}
      onMountedChange={handleMountedChange}
      onGutterPointerDown={handleGutterPointerDown}
      readTerminalScreen={props.readTerminalScreen}
      passthroughActive={props.passthroughActive}
    />,
    dockContainer
  )
}
