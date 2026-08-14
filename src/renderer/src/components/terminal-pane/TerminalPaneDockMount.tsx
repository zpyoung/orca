import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentComposerHandle } from '../agent-composer/agent-composer-types'
import { TerminalDock, terminalDockGutterHeightPx } from '../terminal-dock/TerminalDock'
import { applyTerminalDockGeometryChange } from './terminal-pane-dock-geometry'
import { beginTerminalDockGutterDrag } from './terminal-pane-dock-gutter-drag'
import {
  resolveTerminalDockFocusTransition,
  type TerminalDockFocusState
} from './terminal-pane-dock-focus-transition'

/** ManagedPane's public view drops the internal dockContainer field (pane-public-view.ts), so
 *  reach it the same way the pane DOM itself advertises it: the '.pane-dock-slot' class every
 *  pane's container carries (pane-dom-creation.ts). */
function findDockContainer(pane: ManagedPane): HTMLElement | null {
  return pane.container.querySelector<HTMLElement>('.pane-dock-slot')
}

/** Same reach-through-the-DOM approach as findDockContainer, for the sibling xterm-container
 *  the pane's own pointerdown-focus routing lives outside this module's scope to edit. */
function findXtermContainer(pane: ManagedPane): HTMLElement | null {
  return pane.container.querySelector<HTMLElement>('.xterm-container')
}

export function terminalPaneUsesConptyBelowWrapMarkers(pane: ManagedPane): boolean {
  const windowsPty = pane.terminal.options?.windowsPty
  return windowsPty?.backend === 'conpty' && windowsPty.buildNumber === undefined
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
  onInitialize?: () => void
  onCommitGutterRows: (rows: number) => void
  onEffectiveMountedChange?: (mounted: boolean) => void
  passthroughActive: boolean
}

/** Portals the dock into the pane's reserved DOM slot and owns the single point where its
 *  DOM geometry changes (mount/unmount edges, live drag) get coalesced into exactly one PTY
 *  resize. Renders nothing when not docked — the caller already gates the experimental flag
 *  and agent eligibility, so reaching here at all means the feature is live for this pane. */
export function TerminalPaneDockMount(props: TerminalPaneDockMountProps): React.JSX.Element | null {
  const { pane, docked, passthroughActive, onEffectiveMountedChange } = props
  const dockRef = useRef<AgentComposerHandle>(null)
  const cancelGutterDragRef = useRef<(() => void) | null>(null)
  const [liveGutterRows, setLiveGutterRows] = useState<number | null>(null)
  // Why: the auto-undock hysteresis needs the pane's own available height, not the
  // terminal's — the split layout fixes this pane's box; only the internal xterm/dock
  // split moves, so this never feeds back into itself when the dock mounts or resizes.
  const [paneHeightPx, setPaneHeightPx] = useState(
    () => pane.container.getBoundingClientRect().height
  )
  const [effectiveDockMounted, setEffectiveDockMounted] = useState(false)
  const dockContainer = useMemo(() => findDockContainer(pane), [pane])

  useEffect(
    () => () => {
      cancelGutterDragRef.current?.()
      cancelGutterDragRef.current = null
    },
    [docked]
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

  const onInitializeRef = useRef(props.onInitialize)
  onInitializeRef.current = props.onInitialize
  useEffect(() => {
    onInitializeRef.current?.()
  }, [props.paneKey])

  // Why: seeded from the initial props rather than {docked: false, passthroughActive: false}
  // so an already-docked pane on first mount (e.g. restored session) isn't read as a fresh
  // dock transition and doesn't steal focus from whatever the app is doing at startup.
  const focusStateRef = useRef<TerminalDockFocusState>({
    docked: effectiveDockMounted,
    passthroughActive
  })
  useEffect(() => {
    const previous = focusStateRef.current
    const next: TerminalDockFocusState = { docked: effectiveDockMounted, passthroughActive }
    focusStateRef.current = next
    const action = resolveTerminalDockFocusTransition(previous, next)
    if (action === 'focus-composer') {
      dockRef.current?.focus()
    } else if (action === 'focus-terminal') {
      pane.terminal.focus()
    }
  }, [effectiveDockMounted, passthroughActive, pane])

  // Why: while docked (and not in passthrough), a terminal pointerdown must still select and
  // scroll xterm but not take keyboard focus from the composer — data-pane-prevent-terminal-focus
  // is the opt-out shouldFocusTerminalFromPanePointerDown already honors, so toggling it here
  // reaches the desired behavior without touching the pane-manager focus-gate default itself.
  useEffect(() => {
    const xtermContainer = findXtermContainer(pane)
    if (!xtermContainer) {
      return undefined
    }
    if (effectiveDockMounted && !passthroughActive) {
      xtermContainer.setAttribute('data-pane-prevent-terminal-focus', '')
    } else {
      xtermContainer.removeAttribute('data-pane-prevent-terminal-focus')
    }
    return () => {
      xtermContainer.removeAttribute('data-pane-prevent-terminal-focus')
    }
  }, [pane, effectiveDockMounted, passthroughActive])

  const { gutterRows, onCommitGutterRows } = props
  const renderedGutterRows = liveGutterRows ?? gutterRows
  const handleMountedChange = useCallback(
    (mounted: boolean) => {
      if (!mounted) {
        cancelGutterDragRef.current?.()
        cancelGutterDragRef.current = null
      }
      setEffectiveDockMounted(mounted)
      onEffectiveMountedChange?.(mounted)
      if (!dockContainer) {
        return
      }
      const height = mounted ? terminalDockGutterHeightPx(renderedGutterRows) : 0
      applyTerminalDockGeometryChange(pane, undefined, () => {
        dockContainer.style.height = `${height}px`
        pane.container.style.setProperty('--terminal-dock-height', `${height}px`)
      })
    },
    [dockContainer, pane, onEffectiveMountedChange, renderedGutterRows]
  )

  useLayoutEffect(() => {
    if (!dockContainer || !effectiveDockMounted) {
      return
    }
    const height = terminalDockGutterHeightPx(renderedGutterRows)
    if (dockContainer.style.height === `${height}px`) {
      return
    }
    applyTerminalDockGeometryChange(pane, undefined, () => {
      dockContainer.style.height = `${height}px`
      pane.container.style.setProperty('--terminal-dock-height', `${height}px`)
    })
  }, [dockContainer, effectiveDockMounted, pane, renderedGutterRows])

  const handleGutterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      cancelGutterDragRef.current?.()
      cancelGutterDragRef.current = beginTerminalDockGutterDrag(event, {
        pane,
        startGutterRows: gutterRows,
        onLiveRowsChange: (rows) => {
          if (dockContainer) {
            const height = terminalDockGutterHeightPx(rows)
            dockContainer.style.height = `${height}px`
            pane.container.style.setProperty('--terminal-dock-height', `${height}px`)
          }
          setLiveGutterRows(rows)
        },
        onCommit: (rows) => {
          setLiveGutterRows(null)
          onCommitGutterRows(rows)
        }
      })
    },
    [dockContainer, gutterRows, onCommitGutterRows, pane]
  )

  if (!docked || !dockContainer) {
    return null
  }

  return createPortal(
    <TerminalDock
      ref={dockRef}
      terminalTabId={props.terminalTabId}
      paneKey={props.paneKey}
      targetPtyId={props.targetPtyId}
      agent={props.agent}
      paneHeightPx={paneHeightPx}
      gutterRows={renderedGutterRows}
      disabledReason={props.disabledReason}
      onMountedChange={handleMountedChange}
      onGutterPointerDown={handleGutterPointerDown}
      readTerminalScreen={props.readTerminalScreen}
      isLocalConptyBelowWrapMarkers={terminalPaneUsesConptyBelowWrapMarkers(pane)}
      passthroughActive={props.passthroughActive}
    />,
    dockContainer
  )
}
